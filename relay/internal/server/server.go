// Package server is the relay: it logs peers in against the registry,
// keeps the live session list in memory, and routes frames between
// sessions and clients without reading their payloads (docs/design.md,
// sections 5 and 7).
package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"pirc.dev/relay/internal/proxy"
	"pirc.dev/relay/internal/registry"
)

// AuthContext prefixes the challenge nonce in the signed bytes
// (relay.proto, Auth).
const AuthContext = "pirc-auth-v1alpha1\x00"

// Software is reported in Welcome; pirc-relay sets it to its version.
var Software = "pirc-relay/dev"

type Config struct {
	Registry      *registry.Registry
	MaxFrameBytes int
	// How long a peer has to finish logging in, and to send its first
	// frame, which it does as soon as it connects.
	LoginTimeout time.Duration
	HelloTimeout time.Duration
	// How often the registry file is reread (revocation).
	RegistryPoll time.Duration
	PingInterval time.Duration
	// Frames, and bytes, queued for a slow peer before it is disconnected.
	SendQueue      int
	SendQueueBytes int
	// Connections that have not finished logging in, in all and from one
	// address (proxy.ClientAddr); more are refused.
	MaxPendingLogins        int
	MaxPendingLoginsPerAddr int
	// The largest session announcement: names, folders and models, a few
	// hundred bytes. Every subscribing client is sent every one at once.
	MaxAnnounceBytes int
	// Sessions one connection may have live at once.
	MaxSessionsPerConn int
	// Proxies whose X-Forwarded-For is believed (see proxy.ClientAddr). None by
	// default: anyone else could write any address there.
	TrustedProxies []netip.Prefix
	// The push gateway clients registered for push are woken through
	// (ParseGateway); none when empty. At most one wake per client per
	// WakeWindow, and one more at its end if asked for meanwhile.
	PushGateway string
	WakeWindow  time.Duration
	// No new hosts but those the operator adds (pirc-relay add-host): no
	// host asks for approval, and clients get no tokens for hosts. For a
	// relay whose clients are not the operator's own, such as one for
	// store review, where a client's link must not admit a computer.
	ClosedToHosts bool
	Logger        *slog.Logger
	Now           func() time.Time
}

func (c *Config) defaults() error {
	if c.MaxFrameBytes == 0 {
		c.MaxFrameBytes = 16 << 20
	}
	if c.MaxFrameBytes < MinFrameLimit || c.MaxFrameBytes > MaxFrameLimit {
		return fmt.Errorf("max frame bytes must be between %d and %d", MinFrameLimit, MaxFrameLimit)
	}
	if c.LoginTimeout == 0 {
		c.LoginTimeout = 10 * time.Second
	}
	if c.HelloTimeout == 0 {
		c.HelloTimeout = 5 * time.Second
	}
	if c.RegistryPoll == 0 {
		c.RegistryPoll = time.Second
	}
	if c.PingInterval == 0 {
		c.PingInterval = 25 * time.Second
	}
	if c.SendQueue == 0 {
		c.SendQueue = 256
	}
	if c.SendQueueBytes == 0 {
		c.SendQueueBytes = 4 * c.MaxFrameBytes
	}
	if c.MaxPendingLogins == 0 {
		c.MaxPendingLogins = 256
	}
	if c.MaxPendingLoginsPerAddr == 0 {
		c.MaxPendingLoginsPerAddr = 8
	}
	if c.MaxAnnounceBytes == 0 {
		c.MaxAnnounceBytes = 64 << 10
	}
	if c.MaxSessionsPerConn == 0 {
		c.MaxSessionsPerConn = 32
	}
	if c.WakeWindow == 0 {
		c.WakeWindow = 10 * time.Second
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return nil
}

type Server struct {
	cfg     Config
	log     *slog.Logger
	pending atomic.Int64

	// Logins in progress by address.
	pendingMu     sync.Mutex
	pendingByAddr map[string]int

	// Serialises registry reloads, so snapshots are installed in order.
	reloadMu sync.Mutex

	mu sync.Mutex
	// The latest registry snapshot; nil while the file cannot be read, and
	// then nobody may log in.
	reg         *registry.Data
	regStamp    registry.Stamp
	conns       map[*conn]struct{}
	sessions    map[sessionID]*session
	subscribers map[*conn]struct{}
	// Clients watching the hosts awaiting approval, and the PendingHosts
	// frame last sent to them, encoded.
	watchers    map[*conn]struct{}
	pendingSent []byte
	// Clients watching the registered keys, and the Keys frame last sent
	// to them, encoded.
	keyWatchers map[*conn]struct{}
	keysSent    []byte

	// Nil without a push gateway.
	waker *waker
}

func New(cfg Config) (*Server, error) {
	if err := cfg.defaults(); err != nil {
		return nil, err
	}
	s := &Server{
		cfg:           cfg,
		log:           cfg.Logger,
		conns:         map[*conn]struct{}{},
		pendingByAddr: map[string]int{},
		sessions:      map[sessionID]*session{},
		subscribers:   map[*conn]struct{}{},
		watchers:      map[*conn]struct{}{},
		keyWatchers:   map[*conn]struct{}{},
	}
	if err := s.reloadRegistry(true); err != nil {
		return nil, err
	}
	if cfg.PushGateway != "" {
		s.waker = newWaker(s)
	}
	return s, nil
}

// Run rereads the registry every RegistryPoll until ctx ends.
func (s *Server) Run(ctx context.Context) {
	t := time.NewTicker(s.cfg.RegistryPoll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = s.reloadRegistry(true)
		}
	}
}

// Shutdown closes every connection with a close handshake, waiting until
// they finish or ctx ends.
func (s *Server) Shutdown(ctx context.Context) {
	s.mu.Lock()
	conns := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	for _, c := range conns {
		c.close(websocket.StatusGoingAway, "relay shutting down")
	}
	for _, c := range conns {
		select {
		case <-c.closed:
		case <-ctx.Done():
			return
		}
	}
}

// reloadRegistry rereads the registry, unless force is false and the file
// looks unchanged, and disconnects peers whose keys are no longer
// registered with their role. When the file cannot be read, it logs that,
// and logins are refused until it can.
func (s *Server) reloadRegistry(force bool) error {
	s.reloadMu.Lock()
	defer s.reloadMu.Unlock()
	st := s.cfg.Registry.Stamp()
	s.mu.Lock()
	unchanged := !force && s.reg != nil && st.Same(s.regStamp)
	s.mu.Unlock()
	if unchanged {
		return nil
	}
	d, err := s.cfg.Registry.Load()
	s.mu.Lock()
	if err != nil {
		s.reg = nil
		s.mu.Unlock()
		s.log.Error("registry unreadable, refusing logins", "err", err)
		return err
	}
	s.reg, s.regStamp = d, st
	var revoked []*conn
	for c := range s.conns {
		if !d.Admits(c.key, c.role, c.readOnly) {
			revoked = append(revoked, c)
		}
	}
	s.relabelLocked()
	s.pushPendingLocked()
	s.pushKeysLocked()
	s.mu.Unlock()
	for _, c := range revoked {
		s.log.Info("key revoked, disconnecting", "key", registry.EncodeKey(c.key), "label", c.label)
		c.close(websocket.StatusPolicyViolation, "key revoked")
	}
	return nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "OK")
	})
	mux.HandleFunc("GET /v1alpha1", s.serveWS)
	return mux
}

// startLogin counts a login from addr, unless too many are in progress
// from there or in all; done uncounts it.
func (s *Server) startLogin(addr string) (done func(), ok bool) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	if s.pendingByAddr[addr] >= s.cfg.MaxPendingLoginsPerAddr {
		return nil, false
	}
	if s.pending.Add(1) > int64(s.cfg.MaxPendingLogins) {
		s.pending.Add(-1)
		return nil, false
	}
	s.pendingByAddr[addr]++
	var once sync.Once
	return func() {
		once.Do(func() {
			s.pendingMu.Lock()
			defer s.pendingMu.Unlock()
			s.pending.Add(-1)
			if s.pendingByAddr[addr]--; s.pendingByAddr[addr] == 0 {
				delete(s.pendingByAddr, addr)
			}
		})
	}, true
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	addr, remote := proxy.ClientAddr(r, s.cfg.TrustedProxies)
	doneLogin, ok := s.startLogin(addr)
	if !ok {
		http.Error(w, "too many logins in progress", http.StatusServiceUnavailable)
		return
	}
	defer doneLogin()
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Browsers are not clients yet; origins are checked when they are.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(loginReadLimit)
	c := &conn{
		ws:        ws,
		remote:    remote,
		send:      make(chan []byte, s.cfg.SendQueue),
		maxQueued: int64(s.cfg.SendQueueBytes),
		done:      make(chan struct{}),
		closed:    make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go c.writeLoop(ctx, s.cfg.PingInterval)
	defer s.disconnect(c)

	err = s.login(ctx, c)
	doneLogin()
	if errors.Is(err, errAwaiting) {
		// Logged once, when the request was made; the host asks often.
		return
	}
	if err != nil {
		s.log.Info("login failed", "remote", c.remote, "err", err)
		c.close(websocket.StatusPolicyViolation, "login failed")
		return
	}
	ws.SetReadLimit(int64(s.cfg.MaxFrameBytes))
	s.log.Info("connected", "role", c.role, "label", c.label, "key", registry.EncodeKey(c.key), "software", c.software, "remote", c.remote)
	s.readLoop(ctx, c)
}
