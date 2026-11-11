// Logging a peer in: Hello, Challenge, Auth, Welcome, and asking for
// approval of a key the registry does not know (relay.proto).

package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"time"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	"pirc.dev/relay/internal/registry"
)

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
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "expected Hello")
	}
	if hello.GetProtocolVersion() != pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA1 {
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED, "protocol version not supported")
	}
	var role registry.Role
	switch hello.GetRole() {
	case pb.Role_ROLE_HOST:
		role = registry.RoleHost
	case pb.Role_ROLE_CLIENT:
		role = registry.RoleClient
	default:
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_INVALID, "role missing")
	}
	pub := hello.GetPublicKey()
	if len(pub) != ed25519.PublicKeySize {
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_INVALID, "public key must be 32 bytes")
	}
	token := hello.GetRegistrationToken()
	if len(token) > MaxTokenBytes || len(hello.GetLabel()) > registry.MaxLabelBytes || len(hello.GetSoftware()) > MaxSoftwareBytes {
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_INVALID, "field too long")
	}

	// Decide before the challenge whether this key may log in at all.
	if err := s.reloadRegistry(false); err != nil {
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_INTERNAL, "registry unavailable")
	}
	s.mu.Lock()
	reg := s.reg
	s.mu.Unlock()
	if reg == nil {
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_INTERNAL, "registry unavailable")
	}
	known, isKnown := reg.Lookup(pub)
	// A client's read-only key logs in as that client, needing no token.
	_, readOnly := reg.LookupRead(pub)
	// A host without a token asks the operator to approve its key, once it
	// has proved it holds it (docs/design.md, 5.3).
	asking := !isKnown && !readOnly && token == "" && role == registry.RoleHost
	switch {
	case readOnly && (role != registry.RoleClient || token != ""):
		// Not enrolled as a key of its own, which would make a login with
		// it ambiguous.
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED, "key is a client's read-only key")
	case readOnly:
	case isKnown && known.Role != role:
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED, "key is registered with another role")
	case asking && s.cfg.ClosedToHosts:
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED, "this relay takes no new hosts but those its operator adds")
	case asking:
	case !isKnown && token == "":
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "key not registered")
	case !isKnown:
		if err := reg.CheckToken(token, role, s.cfg.Now()); err != nil {
			return c.fail(ctx, pb.ErrorCode_ERROR_CODE_TOKEN_INVALID, err.Error())
		}
	}

	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	if err := s.writeNow(ctx, c, &pb.Frame{Body: &pb.Frame_Challenge{Challenge: &pb.Challenge{Nonce: nonce}}}); err != nil {
		return err
	}
	f, err = s.readFrame(ctx, c)
	if err != nil {
		return err
	}
	auth := f.GetAuth()
	if auth == nil {
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "expected Auth")
	}
	signed := append([]byte(AuthContext), nonce...)
	if !ed25519.Verify(pub, signed, auth.GetSignature()) {
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "bad signature")
	}
	if asking {
		return s.ask(ctx, c, pub, hello)
	}

	if !isKnown && !readOnly {
		k, err := s.cfg.Registry.Redeem(token, pub, role, hello.GetLabel(), s.cfg.Now())
		if err != nil {
			return c.fail(ctx, pb.ErrorCode_ERROR_CODE_TOKEN_INVALID, err.Error())
		}
		s.log.Info("key registered", "role", role, "label", k.Label, "key", registry.EncodeKey(pub))
		if err := s.reloadRegistry(true); err != nil {
			return c.fail(ctx, pb.ErrorCode_ERROR_CODE_INTERNAL, "registry unavailable")
		}
	}

	// Admit the connection under the lock that installs registry
	// snapshots: a key removed during the challenge is either refused here
	// or disconnected by the reload that saw it go.
	s.mu.Lock()
	var k registry.Key
	ok := false
	if s.reg != nil {
		if readOnly {
			k, ok = s.reg.LookupRead(pub)
		} else {
			k, ok = s.reg.Lookup(pub)
		}
	}
	if !ok || k.Role != role {
		s.mu.Unlock()
		return c.fail(ctx, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "key not registered")
	}
	c.key, c.role, c.label, c.software = pub, role, k.Label, hello.GetSoftware()
	if readOnly {
		c.readOnly = true
		c.owner, _ = registry.DecodeKey(k.PublicKey)
	}
	s.conns[c] = struct{}{}
	s.pushKeysLocked()
	s.mu.Unlock()
	return s.writeNow(ctx, c, &pb.Frame{Body: &pb.Frame_Welcome{Welcome: &pb.Welcome{
		ProtocolVersion: pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA1,
		MaxFrameBytes:   uint32(s.cfg.MaxFrameBytes),
		Software:        Software,
		ReadOnly:        readOnly,
	}}})
}

// errAwaiting ends the login of a host whose key awaits approval.
var errAwaiting = errors.New("awaiting approval")

// requestRefresh is how stale a request may get before a host asking again
// rewrites it; every pi process on the host asks every few seconds.
const requestRefresh = time.Minute

// ask records pub's request for approval, or refreshes it, and tells the
// host to wait.
func (s *Server) ask(ctx context.Context, c *conn, pub []byte, hello *pb.Hello) error {
	now := s.cfg.Now()
	s.mu.Lock()
	var q registry.Request
	seen := false
	if s.reg != nil {
		q, seen = s.reg.Requested(pub)
	}
	s.mu.Unlock()
	// Not even a changed label rewrites it sooner: a host could change it
	// on every attempt.
	// The registry checks again under its lock, for hosts asking at once.
	if !seen || now.Sub(q.LastSeen) >= requestRefresh {
		created, err := s.cfg.Registry.Request(pub, hello.GetLabel(), hello.GetSoftware(), c.remote, now, requestRefresh)
		if errors.Is(err, registry.ErrTooMany) {
			return c.fail(ctx, pb.ErrorCode_ERROR_CODE_RATE_LIMITED, err.Error())
		}
		if err != nil {
			s.log.Error("cannot record a request for approval", "err", err)
			return c.fail(ctx, pb.ErrorCode_ERROR_CODE_INTERNAL, "registry unavailable")
		}
		if created {
			s.log.Info("host awaiting approval", "label", hello.GetLabel(), "key", registry.EncodeKey(pub), "remote", c.remote, "software", hello.GetSoftware())
		}
		_ = s.reloadRegistry(true)
	}
	c.fail(ctx, pb.ErrorCode_ERROR_CODE_APPROVAL_PENDING, "awaiting approval: approve it in a PiRC client, or on the relay run pirc-relay approve "+registry.EncodeKey(pub))
	return errAwaiting
}
