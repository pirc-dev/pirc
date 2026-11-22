// Package hosted is the relay's hosted mode (docs/e2e.md; docs/design.md,
// step 14): many accounts, each with its newest device list, signed by
// the account's phone, which decides the keys the relay admits and the
// role of each. Signing up makes an account with the phone's version 1.
// It speaks v1alpha2 only; a relay started in this mode serves no
// v1alpha1 at all, and the self-hosted mode (package server) knows nothing
// of it.
//
// It passes announcements, routed frames and join steps on unread, and
// keeps no label of any device.
package hosted

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
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

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
	"pirc.dev/relay/internal/proxy"
)

// AuthContext is the login signature's context (relay.proto, Auth).
const AuthContext = "pirc-auth-v1alpha2"

// framed is how every signed string is built (docs/e2e.md, section 2):
// the context's ASCII, a NUL byte, then each part prefixed by its length as
// an unsigned LEB128. Every context is a constant, so one that is empty or
// holds a byte outside 0x20..0x7E is a mistake in the code: framed panics.
func framed(context string, parts ...[]byte) []byte {
	if context == "" {
		panic("hosted: framed: empty context")
	}
	for i := 0; i < len(context); i++ {
		if c := context[i]; c < 0x20 || c > 0x7e {
			panic(fmt.Sprintf("hosted: framed: context byte %#x at %d", c, i))
		}
	}
	out := append([]byte(context), 0)
	for _, p := range parts {
		out = binary.AppendUvarint(out, uint64(len(p)))
		out = append(out, p...)
	}
	return out
}

// framedNumber is a number as a framed part holds it: 8 bytes,
// big-endian (docs/e2e.md, section 2). Only list_test.go calls it, for
// cases/e2e/framed.json. A value of 2^63 or more panics.
func framedNumber(v uint64) []byte {
	if v >= 1<<63 {
		panic(fmt.Sprintf("hosted: framedNumber: %d is 2^63 or more", v))
	}
	return binary.BigEndian.AppendUint64(nil, v)
}

// Path is where the hosted relay serves its WebSocket.
const Path = "/v1alpha2"

// Limits on what the relay stores or passes on.
const (
	MaxIDBytes = 128
	// The largest frame accepted before Welcome.
	loginReadLimit = 4096
	// A join step, and the steps one join may pass on.
	maxJoinStepBytes   = 128 << 10
	maxJoinSteps       = 8
	MaxPushHandleBytes = 4096
)

type Config struct {
	Store *Store
	// The relay's origin as devices reach it, such as wss://relay.example:
	// every login signs it (relay.proto, Auth).
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
	// How long a join's wait lasts.
	JoinTimeout time.Duration
	// How long an account stays locked before it is deleted (lock.go).
	LockedFor time.Duration
	// Join lookups per hour, per account and per address; and joins one
	// address may be waiting on at once.
	MaxLookupsPerAccount int
	MaxLookupsPerAddr    int
	MaxWaitsPerAddr      int
	// List versions taken per hour, per account.
	MaxListPublishesPerAccount int
	// Connections logged in at once, per key and per account; more are
	// refused.
	MaxConnsPerKey     int
	MaxConnsPerAccount int
	TrustedProxies     []netip.Prefix
	Logger             *slog.Logger
	Now                func() time.Time
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
	seti(&c.MaxListPublishesPerAccount, 30)
	seti(&c.MaxConnsPerKey, 64)
	seti(&c.MaxConnsPerAccount, 512)
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
	// List versions taken this hour, by account.
	listPublishes     map[string]*counter
	lastPublishesTrim time.Time
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
		listPublishes: map[string]*counter{},
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
// in memory: its newest list, connections and live sessions.
type account struct {
	id    []byte
	list  *accountList
	conns map[*conn]struct{}
	// Live sessions.
	sessions    map[sessionID]*session
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
// connection has it in memory; nil when there is none. A list in the
// store that its check does not accept is an error. Under s.mu.
func (s *Server) loadLocked(id []byte) (*account, error) {
	if a := s.accounts[string(id)]; a != nil {
		return a, nil
	}
	ok, err := s.store.HasAccount(id)
	if err != nil || !ok {
		return nil, err
	}
	l, err := s.readList(id)
	if err != nil {
		s.log.Error("cannot read an account's list", "account", shortKey(id), "err", err)
		return nil, err
	}
	a := &account{
		id:          id,
		list:        l,
		conns:       map[*conn]struct{}{},
		sessions:    map[sessionID]*session{},
		subscribers: map[*conn]struct{}{},
		watchers:    map[*conn]struct{}{},
	}
	s.accounts[string(id)] = a
	return a, nil
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
	// Membership is decided only after the challenge, so that an answer
	// before it tells nobody holding a public key whether that key is on
	// an account's list.

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
	if !ed25519.Verify(pub, framed(AuthContext, id, []byte(s.cfg.Origin), nonce), auth.GetSignature()) {
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "bad signature")
	}

	// Admit under the lock that deleting the account takes: an account
	// deleted during the challenge has no list left.
	s.mu.Lock()
	removedList, ferr := s.admitByListLocked(c, pub, id, nonce, hello.GetListCounter())
	s.mu.Unlock()
	if removedList != nil {
		// A key a version removed: the newest list, written before the
		// refusal, so that a device removed while offline learns of it.
		if b, err := proto.Marshal(&pb.Frame{Body: &pb.Frame_List{List: &pb.List{List: removedList}}}); err == nil {
			wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			c.ws.Write(wctx, websocket.MessageBinary, b)
			cancel()
		}
		return c.fail(ctx, pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, errRemoved)
	}
	if ferr != nil {
		return c.fail(ctx, ferr.code, ferr.msg)
	}
	return nil
}

const errRemoved = "removed"

// admitByListLocked admits c, whose login's signature has checked, by the
// account's newest list, or says why not; for a key a version of the list
// removed, it returns the newest list as signed instead. Under s.mu.
func (s *Server) admitByListLocked(c *conn, pub, id, nonce []byte, held uint64) ([]byte, *frameError) {
	notMember := &frameError{code: pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, msg: "key not a member of the account"}
	unavailable := &frameError{code: pb1.ErrorCode_ERROR_CODE_INTERNAL, msg: "store unavailable"}
	c.key = pub
	c.nonce = nonce
	if len(id) == 0 {
		s.conns[c] = struct{}{}
		c.queue(&pb.Frame{Body: &pb.Frame_Welcome{Welcome: &pb.Welcome{
			ProtocolVersion: pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2,
			MaxFrameBytes:   uint32(s.cfg.MaxFrameBytes),
		}}})
		return nil, nil
	}
	a, err := s.loadLocked(id)
	if err != nil {
		return nil, unavailable
	}
	if a == nil {
		return nil, notMember
	}
	device, role := a.list.deviceFor(pub)
	if device == nil {
		s.unloadLocked(a)
		removed, err := s.store.Removed(id, pub)
		if err != nil {
			return nil, unavailable
		}
		if removed {
			return a.list.signed, nil
		}
		return nil, notMember
	}
	// Removed connections waiting to close count toward neither cap.
	sameKey, live := 0, 0
	for o := range a.conns {
		if o.removed {
			continue
		}
		live++
		if bytes.Equal(o.key, pub) {
			sameKey++
		}
	}
	if sameKey >= s.cfg.MaxConnsPerKey || live >= s.cfg.MaxConnsPerAccount {
		s.unloadLocked(a)
		return nil, rateLimited("too many connections")
	}
	locked, _, err := s.store.Locked(id)
	if err != nil {
		s.unloadLocked(a)
		return nil, unavailable
	}
	if locked && role != pb.DeviceRole_DEVICE_ROLE_CLIENT {
		s.unloadLocked(a)
		return nil, denied(errLocked)
	}
	// What a client is told it pays with: unread, it is not told none.
	subs, err := s.subscriptionsFor(a, role)
	if err != nil {
		s.unloadLocked(a)
		return nil, unavailable
	}
	c.device = device
	w := &pb.Welcome{
		ProtocolVersion: pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2,
		MaxFrameBytes:   uint32(s.cfg.MaxFrameBytes),
		Role:            role,
		Locked:          locked,
		Subscriptions:   subs,
		ListCounter:     a.list.counter,
	}
	if a.list.counter > held {
		w.List = a.list.signed
	}
	if locked {
		s.admitLockedAccountLocked(c, a, w)
		return nil, nil
	}
	s.admitLocked(c, a, w)
	return nil, nil
}

// seenKey is the device row a connection's last seen goes to: its
// signing key, or for a read-only key its phone's.
func (c *conn) seenKey() []byte {
	if c.device != nil {
		return c.device.GetSigningKey()
	}
	return c.key
}

// admitLocked logs c in to account a, with Welcome. Under s.mu.
func (s *Server) admitLocked(c *conn, a *account, w *pb.Welcome) {
	c.acct, c.role = a, w.Role
	s.conns[c] = struct{}{}
	a.conns[c] = struct{}{}
	if err := s.store.Seen(a.id, c.seenKey(), s.cfg.Now().UnixMilli()); err != nil {
		s.log.Error("cannot record a device as seen", "err", err)
	}
	c.queue(&pb.Frame{Body: &pb.Frame_Welcome{Welcome: w}})
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
	if !a.deleted && !c.removed {
		if err := s.store.Seen(a.id, c.seenKey(), s.cfg.Now().UnixMilli()); err != nil {
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
	if c.removed {
		// Its device is off the list: nothing it sends is taken.
		s.mu.Unlock()
		return nil
	}
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
		case *pb.Frame_PublishList:
			return s.publishList(c, b.PublishList).withID(b.PublishList.GetRequestId())
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
	case *pb.Frame_PublishList:
		// Answered by Done, which publishList sends before the List
		// frames that follow it.
		return only(host || client, "a read-only key publishes no list", func() *frameError { return s.publishList(c, b.PublishList) }).withID(b.PublishList.GetRequestId())
	case *pb.Frame_DeleteAccount:
		// Answered by Done before the close, which deleteAccount sends.
		return s.deleteAccount(c, b.DeleteAccount.GetRequestId()).withID(b.DeleteAccount.GetRequestId())
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
