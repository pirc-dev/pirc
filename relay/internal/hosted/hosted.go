// Package hosted is the relay's hosted mode (docs/e2e.md; docs/design.md,
// step 14, stage 2): many accounts, each a device list its own clients
// sign, which the relay checks and admits keys by but cannot change.
// It speaks v1alpha2 only; a relay started in this mode serves no
// v1alpha1 at all, and the self-hosted mode (package server) knows nothing
// of it.
//
// What it routes it cannot read: announcements and routed frames are
// encrypted between a session and its account's clients, and the relay
// keeps no label of any device.
package hosted

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"pirc.dev/relay/internal/e2e"
	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
	"pirc.dev/relay/internal/proxy"
)

// AuthContext is the login signature's context (relay.proto, Auth).
const AuthContext = "pirc-auth-v1alpha2"

// Path is where the hosted relay serves its WebSocket.
const Path = "/v1alpha2"

// Limits on what the relay stores or passes on.
const (
	MaxIDBytes = 128
	// The largest frame accepted before Welcome.
	loginReadLimit = 4096
	// A bundle with 256 devices is about 70 KB.
	maxBundleBytes = 128 << 10
	// Bundles one connection may have stored at once.
	maxBundlesPerConn = 16
	// A join step: the approval carries a version of up to 256 devices.
	maxJoinStepBytes = 128 << 10
	maxJoinSteps     = 8
	// A label-key wrap: HPKE's 32-byte key and a 48-byte ciphertext.
	maxWrapBytes = 256
	// A label record: 256 labels of 128 bytes, sealed.
	maxLabelsBytes     = 64 << 10
	MaxPushHandleBytes = 4096
)

type Config struct {
	Store *Store
	// The relay's origin as devices reach it, such as wss://relay.example:
	// every login signs it (docs/e2e.md, section 2).
	Origin string
	// Checks a phone's attestation and subscription; without one, nobody
	// can sign up, and a phone's attestation in a join is refused.
	Verifier      Verifier
	MaxFrameBytes int
	LoginTimeout  time.Duration
	HelloTimeout  time.Duration
	PingInterval  time.Duration
	// Frames, and bytes, queued for a slow peer before it is disconnected.
	SendQueue      int
	SendQueueBytes int
	// Connections that have not finished logging in, in all and from one
	// address; more are refused.
	MaxPendingLogins        int
	MaxPendingLoginsPerAddr int
	MaxAnnounceBytes        int
	MaxSessionsPerConn      int
	// How long a join code is good for (docs/e2e.md, section 5).
	JoinTimeout time.Duration
	// How long an account stays locked before it is deleted (lock.go).
	LockedFor time.Duration
	// Join lookups per hour, per account and per address; and joins one
	// address may be waiting on at once.
	MaxLookupsPerAccount int
	MaxLookupsPerAddr    int
	MaxWaitsPerAddr      int
	TrustedProxies       []netip.Prefix
	Logger               *slog.Logger
	Now                  func() time.Time
}

func (c *Config) defaults() error {
	if c.Store == nil {
		return errors.New("hosted: no store")
	}
	if c.Origin == "" {
		return errors.New("hosted: the relay's origin is needed")
	}
	if c.MaxFrameBytes == 0 {
		c.MaxFrameBytes = 16 << 20
	}
	if c.MaxFrameBytes < 256<<10 {
		return fmt.Errorf("hosted: max frame bytes must be at least %d", 256<<10)
	}
	set := func(p *time.Duration, d time.Duration) {
		if *p == 0 {
			*p = d
		}
	}
	set(&c.LoginTimeout, 10*time.Second)
	set(&c.HelloTimeout, 5*time.Second)
	set(&c.PingInterval, 25*time.Second)
	set(&c.JoinTimeout, 10*time.Minute)
	set(&c.LockedFor, 60*24*time.Hour)
	seti := func(p *int, n int) {
		if *p == 0 {
			*p = n
		}
	}
	seti(&c.SendQueue, 256)
	seti(&c.SendQueueBytes, 4*c.MaxFrameBytes)
	seti(&c.MaxPendingLogins, 256)
	seti(&c.MaxPendingLoginsPerAddr, 8)
	seti(&c.MaxAnnounceBytes, 64<<10)
	seti(&c.MaxSessionsPerConn, 32)
	seti(&c.MaxLookupsPerAccount, 20)
	seti(&c.MaxLookupsPerAddr, 20)
	seti(&c.MaxWaitsPerAddr, 4)
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
	store   *Store
	pending atomic.Int64

	pendingMu     sync.Mutex
	pendingByAddr map[string]int

	// Guards everything below, and every change to the store, which is
	// made under it so that what is stored and what is sent agree.
	mu sync.Mutex
	// Accounts with a connection, by ID.
	accounts map[string]*account
	// Every logged-in connection.
	conns map[*conn]struct{}
	joins joins
}

func New(cfg Config) (*Server, error) {
	if err := cfg.defaults(); err != nil {
		return nil, err
	}
	return &Server{
		cfg:           cfg,
		log:           cfg.Logger,
		store:         cfg.Store,
		pendingByAddr: map[string]int{},
		accounts:      map[string]*account{},
		conns:         map[*conn]struct{}{},
		joins:         newJoins(),
	}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "OK")
	})
	mux.HandleFunc("GET "+Path, s.serveWS)
	return mux
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
		// The hosted web client comes in stage 9, with its origin.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(loginReadLimit)
	c := &conn{
		ws:        ws,
		addr:      addr,
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
	if err != nil {
		s.log.Info("login failed", "remote", c.remote, "err", err)
		c.close(websocket.StatusPolicyViolation, "login failed")
		return
	}
	ws.SetReadLimit(int64(s.cfg.MaxFrameBytes))
	s.log.Info("connected", "account", c.accountName(), "role", c.role, "key", shortKey(c.key), "remote", c.remote)
	s.readLoop(ctx, c)
}

func shortKey(k []byte) string { return fmt.Sprintf("%x", k[:min(len(k), 6)]) }

// account is an account with at least one connection, as the relay has it
// in memory: its latest version, and its live sessions and bundles.
type account struct {
	id     []byte
	latest *e2e.Version
	conns  map[*conn]struct{}
	// Live sessions, and the bundles of the processes that serve them.
	sessions    map[sessionID]*session
	bundles     map[string]*bundle
	subscribers map[*conn]struct{}
	// Clients watching Devices.
	watchers map[*conn]struct{}
	// Deleted, with connections still closing.
	deleted bool
}

func (c *conn) accountName() string {
	if c.acct == nil {
		return ""
	}
	return shortKey(c.acct.id)
}

// loadLocked is the account with that ID, read from the store if no
// connection has it in memory; nil when there is none. Under s.mu.
func (s *Server) loadLocked(id []byte) (*account, error) {
	if a := s.accounts[string(id)]; a != nil {
		return a, nil
	}
	obj, err := s.store.Latest(id)
	if err != nil || obj == nil {
		return nil, err
	}
	v, err := openStored(id, obj)
	if err != nil {
		return nil, err
	}
	a := &account{
		id:          id,
		latest:      v,
		conns:       map[*conn]struct{}{},
		sessions:    map[sessionID]*session{},
		bundles:     map[string]*bundle{},
		subscribers: map[*conn]struct{}{},
		watchers:    map[*conn]struct{}{},
	}
	s.accounts[string(id)] = a
	return a, nil
}

// openStored opens a version the relay stored after checking it.
func openStored(id []byte, obj *pb.SignedObject) (*e2e.Version, error) {
	body, err := e2e.OpenList(nil, obj)
	if err != nil {
		body, err = e2e.OpenList(id, obj)
	}
	if err != nil {
		return nil, fmt.Errorf("stored version does not open: %w", err)
	}
	return &e2e.Version{Body: body, Hash: e2e.Hash(obj), Object: obj}, nil
}

// unloadLocked forgets an account no connection has. Under s.mu.
func (s *Server) unloadLocked(a *account) {
	if len(a.conns) == 0 && s.accounts[string(a.id)] == a {
		delete(s.accounts, string(a.id))
	}
}

func (s *Server) login(ctx context.Context, c *conn) error {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.LoginTimeout)
	defer cancel()

	hctx, hcancel := context.WithTimeout(ctx, s.cfg.HelloTimeout)
	f, err := s.readFrame(hctx, c)
	hcancel()
	if err != nil {
		return err
	}
	hello := f.GetHello()
	if hello == nil {
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "expected Hello")
	}
	if hello.GetProtocolVersion() != pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2 {
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED, "protocol version not supported")
	}
	pub := hello.GetPublicKey()
	if len(pub) != ed25519.PublicKeySize {
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_INVALID, "public key must be 32 bytes")
	}
	id := hello.GetAccountId()
	if len(id) != 0 && len(id) != 32 {
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_INVALID, "account ID must be 32 bytes")
	}
	errNotListed := "key not on the account's list"
	// Decide before the challenge whether this key may log in at all.
	if len(id) > 0 {
		s.mu.Lock()
		a, err := s.loadLocked(id)
		listed := a != nil && e2e.Device(a.latest.Body, pub) != nil
		if a != nil {
			s.unloadLocked(a)
		}
		s.mu.Unlock()
		if err != nil {
			s.log.Error("store unreadable", "err", err)
			return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_INTERNAL, "store unavailable")
		}
		if !listed {
			return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, errNotListed)
		}
	}

	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	c.queue(&pb.Frame{Body: &pb.Frame_Challenge{Challenge: &pb.Challenge{Nonce: nonce}}})
	f, err = s.readFrame(ctx, c)
	if err != nil {
		return err
	}
	auth := f.GetAuth()
	if auth == nil {
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "expected Auth")
	}
	if !e2e.Verify(pub, e2e.Framed(AuthContext, id, []byte(s.cfg.Origin), nonce), auth.GetSignature()) {
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "bad signature")
	}

	// Admit under the lock that takes versions: a key removed during the
	// challenge is refused here, or disconnected by the version that
	// removed it.
	s.mu.Lock()
	defer s.mu.Unlock()
	c.key = pub
	c.nonce = nonce
	if len(id) == 0 {
		s.conns[c] = struct{}{}
		c.queue(&pb.Frame{Body: &pb.Frame_Welcome{Welcome: &pb.Welcome{
			ProtocolVersion: pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2,
			MaxFrameBytes:   uint32(s.cfg.MaxFrameBytes),
		}}})
		return nil
	}
	a, err := s.loadLocked(id)
	if err != nil {
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_INTERNAL, "store unavailable")
	}
	d := (*pb.Device)(nil)
	if a != nil {
		d = e2e.Device(a.latest.Body, pub)
	}
	if d == nil {
		if a != nil {
			s.unloadLocked(a)
		}
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, errNotListed)
	}
	locked, _, err := s.store.Locked(id)
	if err != nil {
		s.unloadLocked(a)
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_INTERNAL, "store unavailable")
	}
	if locked {
		if d.GetRole() != pb.DeviceRole_DEVICE_ROLE_CLIENT {
			s.unloadLocked(a)
			return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED, errLocked)
		}
		s.admitLockedAccountLocked(c, a)
		return nil
	}
	s.admitLocked(c, a, d.GetRole())
	return nil
}

// admitLocked logs c in to account a: Welcome, then every current pre-key,
// and to a client or read-only key the label state. Under s.mu.
func (s *Server) admitLocked(c *conn, a *account, role pb.DeviceRole) {
	c.acct, c.role = a, role
	s.conns[c] = struct{}{}
	a.conns[c] = struct{}{}
	if err := s.store.Seen(a.id, c.key, s.cfg.Now().UnixMilli()); err != nil {
		s.log.Error("cannot record a device as seen", "err", err)
	}
	c.queue(&pb.Frame{Body: &pb.Frame_Welcome{Welcome: &pb.Welcome{
		ProtocolVersion: pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2,
		MaxFrameBytes:   uint32(s.cfg.MaxFrameBytes),
		Role:            role,
		ListVersion:     &pb.VersionRef{Number: a.latest.Body.GetNumber(), Hash: a.latest.Hash},
	}}})
	c.queue(&pb.Frame{Body: &pb.Frame_PreKeys{PreKeys: &pb.PreKeys{PreKeys: s.currentPreKeysLocked(a), All: true}}})
	if role != pb.DeviceRole_DEVICE_ROLE_HOST {
		s.sendLabelStateLocked(c)
	}
	s.pushDevicesLocked(a)
}

// disconnect forgets the connection; safe for one that never logged in.
func (s *Server) disconnect(c *conn) {
	c.close(websocket.StatusNormalClosure, "")
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.conns[c]; !ok {
		return
	}
	delete(s.conns, c)
	s.joins.dropLocked(s, c)
	a := c.acct
	if a == nil {
		return
	}
	delete(a.conns, c)
	delete(a.subscribers, c)
	delete(a.watchers, c)
	for id, se := range a.sessions {
		if se.owner == c {
			s.endLocked(a, id, se)
			continue
		}
		delete(se.attached, c)
	}
	s.pruneBundlesLocked(a)
	if !a.deleted && e2e.Device(a.latest.Body, c.key) != nil {
		if err := s.store.Seen(a.id, c.key, s.cfg.Now().UnixMilli()); err != nil {
			s.log.Error("cannot record a device as seen", "err", err)
		}
	}
	s.pushDevicesLocked(a)
	s.unloadLocked(a)
	s.log.Info("disconnected", "account", c.accountName(), "role", c.role, "key", shortKey(c.key))
}

func (s *Server) readLoop(ctx context.Context, c *conn) {
	for {
		f, err := s.readFrame(ctx, c)
		if err != nil {
			return
		}
		if err := s.handle(ctx, c, f); err != nil {
			c.queue(err.frame())
		}
	}
}

func (s *Server) readFrame(ctx context.Context, c *conn) (*pb.Frame, error) {
	typ, b, err := c.ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, c.fail(ctx, pb1.ErrorCode_ERROR_CODE_INVALID, "text frame")
	}
	f := &pb.Frame{}
	if err := proto.Unmarshal(b, f); err != nil {
		return nil, c.fail(ctx, pb1.ErrorCode_ERROR_CODE_INVALID, "undecodable frame")
	}
	return f, nil
}

// encode marshals a frame the relay sends, refusing one larger than the
// maximum it advertises.
func (s *Server) encode(f *pb.Frame) ([]byte, *frameError) {
	b, err := proto.Marshal(f)
	if err != nil {
		return nil, internal()
	}
	if len(b) > s.cfg.MaxFrameBytes {
		return nil, &frameError{code: pb1.ErrorCode_ERROR_CODE_TOO_LARGE, msg: "frame would exceed the maximum size"}
	}
	return b, nil
}

// handle runs one frame from c. The handlers of an account's frames are
// called under s.mu; those of a connection without an account take it
// themselves, since signing up and attesting ask the stores first.
func (s *Server) handle(ctx context.Context, c *conn, f *pb.Frame) *frameError {
	s.mu.Lock()
	a, role, locked := c.acct, c.role, c.locked
	if a == nil {
		s.mu.Unlock()
		return s.handleNoAccount(ctx, c, f)
	}
	// Renewing asks the store first, outside the lock.
	if r := f.GetRenewSubscription(); r != nil {
		s.mu.Unlock()
		if role != pb.DeviceRole_DEVICE_ROLE_CLIENT {
			return denied("only clients renew the subscription").withID(r.GetRequestId())
		}
		return s.renew(ctx, c, r).withID(r.GetRequestId())
	}
	if locked {
		defer s.mu.Unlock()
		switch b := f.GetBody().(type) {
		case *pb.Frame_DeleteAccount:
			return s.deleteAccount(c, b.DeleteAccount.GetRequestId()).withID(b.DeleteAccount.GetRequestId())
		case *pb.Frame_Error:
			return nil
		}
		return denied(errLocked).withID(requestIDOf(f))
	}
	// Every handler of an account's frames runs under the lock, so that
	// none acts on an account deleted meanwhile.
	defer s.mu.Unlock()
	if a.deleted {
		return denied("account deleted")
	}
	host := role == pb.DeviceRole_DEVICE_ROLE_HOST
	client := role == pb.DeviceRole_DEVICE_ROLE_CLIENT
	readOnly := role == pb.DeviceRole_DEVICE_ROLE_READ_ONLY
	// A request answered by Done: refused unless ok, else run.
	request := func(ok bool, refusal, id string, run func() *frameError) *frameError {
		if !ok {
			return denied(refusal).withID(id)
		}
		if e := run(); e != nil {
			return e.withID(id)
		}
		s.done(c, id)
		return nil
	}
	only := func(ok bool, refusal string, run func() *frameError) *frameError {
		if !ok {
			return denied(refusal)
		}
		return run()
	}
	switch b := f.GetBody().(type) {
	case *pb.Frame_SessionAnnounce:
		return only(host, "only hosts announce sessions", func() *frameError { return s.announce(c, b.SessionAnnounce) })
	case *pb.Frame_SessionEnd:
		return only(host, "only hosts end sessions", func() *frameError { return s.end(c, b.SessionEnd.GetSession()) })
	case *pb.Frame_PublishBundle:
		return request(host, "only hosts publish bundles", b.PublishBundle.GetRequestId(), func() *frameError { return s.publishBundle(c, b.PublishBundle.GetBundle()) })
	case *pb.Frame_SubscribeSessions:
		return only(client || readOnly, "only clients subscribe", func() *frameError { s.subscribe(c); return nil })
	case *pb.Frame_Attach:
		return only(client, "only clients attach", func() *frameError { return s.attach(c, b.Attach.GetSession(), true) })
	case *pb.Frame_Detach:
		return only(client, "only clients detach", func() *frameError { return s.attach(c, b.Detach.GetSession(), false) })
	case *pb.Frame_WatchDevices:
		return only(client, "only clients watch the devices", func() *frameError { s.watchDevices(c); return nil })
	case *pb.Frame_Routed:
		switch {
		case host:
			return s.routeFromHost(c, b.Routed)
		case client:
			return s.routeFromClient(c, b.Routed)
		}
		return denied("a read-only key sends nothing to sessions")
	case *pb.Frame_PublishVersion:
		return request(client, "only clients publish versions", b.PublishVersion.GetRequestId(), func() *frameError { return s.publishVersion(c, b.PublishVersion.GetVersion()) })
	case *pb.Frame_PublishWithdrawal:
		return request(client, "only clients publish withdrawals", b.PublishWithdrawal.GetRequestId(), func() *frameError { return s.publishWithdrawal(c, b.PublishWithdrawal.GetWithdrawal()) })
	case *pb.Frame_GetVersions:
		return s.getVersions(c, b.GetVersions).withID(b.GetVersions.GetRequestId())
	case *pb.Frame_PublishPreKey:
		return request(client || readOnly, "only clients and read-only keys publish pre-keys", b.PublishPreKey.GetRequestId(), func() *frameError { return s.publishPreKey(c, b.PublishPreKey.GetPreKey()) })
	case *pb.Frame_PublishLabels:
		return request(client, "only clients publish labels", b.PublishLabels.GetRequestId(), func() *frameError { return s.publishLabels(c, b.PublishLabels.GetLabels()) })
	case *pb.Frame_PublishLabelKeyWraps:
		return request(client, "only clients publish label-key wraps", b.PublishLabelKeyWraps.GetRequestId(), func() *frameError { return s.publishWraps(c, b.PublishLabelKeyWraps.GetWraps()) })
	case *pb.Frame_RegisterPush:
		return request(client, "only clients register for push", b.RegisterPush.GetRequestId(), func() *frameError { return s.setPush(c, b.RegisterPush.GetHandle()) })
	case *pb.Frame_UnregisterPush:
		return request(client, "only clients register for push", b.UnregisterPush.GetRequestId(), func() *frameError { return s.setPush(c, "") })
	case *pb.Frame_JoinLookup:
		return only(client, "only clients join devices", func() *frameError { return s.joinLookup(c, b.JoinLookup) }).withID(b.JoinLookup.GetRequestId())
	case *pb.Frame_JoinMessage:
		return s.joinMessage(c, b.JoinMessage)
	case *pb.Frame_JoinEnded:
		s.joinEnded(c, b.JoinEnded.GetJoinId())
		return nil
	case *pb.Frame_DeleteAccount:
		// Answered by Done before the close, which deleteAccount sends.
		return only(client, "only clients delete the account", func() *frameError { return s.deleteAccount(c, b.DeleteAccount.GetRequestId()) }).withID(b.DeleteAccount.GetRequestId())
	case *pb.Frame_Error:
		return nil
	}
	return invalid("unexpected frame")
}

func (s *Server) done(c *conn, requestID string) {
	c.queue(&pb.Frame{Body: &pb.Frame_Done{Done: &pb.Done{RequestId: requestID}}})
}

// handleNoAccount is what a connection logged in without an account may
// do: sign up, or wait for a join as a new device.
func (s *Server) handleNoAccount(ctx context.Context, c *conn, f *pb.Frame) *frameError {
	switch b := f.GetBody().(type) {
	case *pb.Frame_SignUp:
		return s.signUp(ctx, c, b.SignUp).withID(b.SignUp.GetRequestId())
	case *pb.Frame_JoinWait:
		return s.joinWait(ctx, c, b.JoinWait)
	case *pb.Frame_JoinMessage:
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.joinMessage(c, b.JoinMessage)
	case *pb.Frame_JoinEnded:
		s.mu.Lock()
		defer s.mu.Unlock()
		s.joinEnded(c, b.JoinEnded.GetJoinId())
		return nil
	case *pb.Frame_Error:
		return nil
	default:
		return denied("logged in without an account: only signing up and joining")
	}
}
