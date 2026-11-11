// The registered devices, as clients see, rename, remove and invite them:
// any registered client may (docs/design.md, 5.3).

package server

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	"pirc.dev/relay/internal/registry"
)

var roles = map[registry.Role]pb.Role{registry.RoleHost: pb.Role_ROLE_HOST, registry.RoleClient: pb.Role_ROLE_CLIENT}

// keysFrameLocked is the Keys frame for the registry snapshot and the
// connections now, encoded. Under s.mu.
func (s *Server) keysFrameLocked() []byte {
	online := map[string]bool{}
	for c := range s.conns {
		online[string(c.key)] = true
	}
	var keys []*pb.RegisteredKey
	for _, k := range s.reg.Sorted() {
		pub, err := registry.DecodeKey(k.PublicKey)
		if err != nil {
			continue
		}
		keys = append(keys, &pb.RegisteredKey{
			PublicKey: pub,
			Role:      roles[k.Role],
			Label:     k.Label,
			AddedAt:   timestamppb.New(k.AddedAt),
			Online:    online[string(pub)],
			Push:      k.PushHandle != "",
			ReadKey:   k.ReadKey != "",
		})
	}
	b, _ := proto.Marshal(&pb.Frame{Body: &pb.Frame_Keys{Keys: &pb.Keys{Keys: keys}}})
	return b
}

// pushKeysLocked sends the list to its watchers when it changed since it
// was last sent: on every registry reload, and when a connection logs in
// or goes. Under s.mu.
func (s *Server) pushKeysLocked() {
	if s.reg == nil || len(s.keyWatchers) == 0 {
		return
	}
	b := s.keysFrameLocked()
	if bytes.Equal(b, s.keysSent) {
		return
	}
	s.keysSent = b
	for c := range s.keyWatchers {
		c.queueBytes(b)
	}
}

func (s *Server) watchKeys(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keyWatchers[c] = struct{}{}
	if s.reg == nil {
		return
	}
	s.keysSent = s.keysFrameLocked()
	c.queueBytes(s.keysSent)
}

// relabelLocked gives the live sessions of each host the label its key is
// registered under now, telling subscribers of those that changed. Under
// s.mu.
func (s *Server) relabelLocked() {
	for _, se := range s.sessions {
		k, ok := s.reg.Lookup(se.owner.key)
		if !ok || k.Label == se.hostLabel {
			continue
		}
		se.hostLabel = k.Label
		upd, err := s.encode(&pb.Frame{Body: &pb.Frame_SessionUpdated{SessionUpdated: &pb.SessionUpdated{Entry: s.entry(se)}}})
		if err != nil {
			continue
		}
		for sub := range s.subscribers {
			sub.queueBytes(upd)
		}
	}
}

// rename sets a registered key's label for a client, and answers it.
func (s *Server) rename(c *conn, r *pb.RenameKey) *frameError {
	requestID := r.GetRequestId()
	fail := func(code pb.ErrorCode, msg string) *frameError {
		return &frameError{code: code, msg: msg, requestID: requestID}
	}
	if requestID == "" || len(requestID) > MaxIDBytes {
		return invalid("a request ID is needed, of at most 128 bytes")
	}
	if len(r.GetPublicKey()) != ed25519.PublicKeySize {
		return fail(pb.ErrorCode_ERROR_CODE_INVALID, "public key must be 32 bytes")
	}
	key := registry.EncodeKey(r.GetPublicKey())
	k, err := s.cfg.Registry.Rename(key, r.GetLabel())
	switch {
	case errors.Is(err, registry.ErrNotFound), errors.Is(err, registry.ErrLabelEmpty), errors.Is(err, registry.ErrLabelTooLong):
		return fail(pb.ErrorCode_ERROR_CODE_INVALID, err.Error())
	case err != nil:
		s.log.Error("cannot rename a key", "key", key, "err", err)
		return fail(pb.ErrorCode_ERROR_CODE_INTERNAL, "registry unavailable")
	}
	s.log.Info("key renamed", "role", k.Role, "label", k.Label, "key", key, "by", c.label)
	// The list and the sessions under the new label go out first, then the
	// answer, as for a decision on a host.
	_ = s.reloadRegistry(true)
	c.queue(&pb.Frame{Body: &pb.Frame_KeyChanged{KeyChanged: &pb.KeyChanged{RequestId: requestID}}})
	return nil
}

// remove takes a registered key out of the registry for a client, and
// answers it. Not the client's own: it would cut itself off, and the web
// app's server holds one key for every browser.
func (s *Server) remove(c *conn, r *pb.RemoveKey) *frameError {
	requestID := r.GetRequestId()
	fail := func(code pb.ErrorCode, msg string) *frameError {
		return &frameError{code: code, msg: msg, requestID: requestID}
	}
	if requestID == "" || len(requestID) > MaxIDBytes {
		return invalid("a request ID is needed, of at most 128 bytes")
	}
	if len(r.GetPublicKey()) != ed25519.PublicKeySize {
		return fail(pb.ErrorCode_ERROR_CODE_INVALID, "public key must be 32 bytes")
	}
	if bytes.Equal(r.GetPublicKey(), c.key) {
		return fail(pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED, "a client cannot remove its own key")
	}
	key := registry.EncodeKey(r.GetPublicKey())
	k, err := s.cfg.Registry.Remove(key)
	switch {
	case errors.Is(err, registry.ErrNotFound):
		return fail(pb.ErrorCode_ERROR_CODE_INVALID, err.Error())
	case err != nil:
		s.log.Error("cannot remove a key", "key", key, "err", err)
		return fail(pb.ErrorCode_ERROR_CODE_INTERNAL, "registry unavailable")
	}
	s.log.Info("key removed", "role", k.Role, "label", k.Label, "key", key, "by", c.label)
	// Its connections close and the list goes out first, then the answer.
	_ = s.reloadRegistry(true)
	c.queue(&pb.Frame{Body: &pb.Frame_KeyChanged{KeyChanged: &pb.KeyChanged{RequestId: requestID}}})
	return nil
}

// Bounds of a token's lifetime asked for by a client.
const (
	DefaultTokenLifetime = 15 * time.Minute
	MaxTokenLifetime     = 24 * time.Hour
)

var registryRoles = map[pb.Role]registry.Role{pb.Role_ROLE_HOST: registry.RoleHost, pb.Role_ROLE_CLIENT: registry.RoleClient}

// issueToken makes a one-time registration token for a client, and sends
// it to that client alone.
func (s *Server) issueToken(c *conn, r *pb.IssueToken) *frameError {
	requestID := r.GetRequestId()
	fail := func(msg string) *frameError {
		return &frameError{code: pb.ErrorCode_ERROR_CODE_INVALID, msg: msg, requestID: requestID}
	}
	if requestID == "" || len(requestID) > MaxIDBytes {
		return invalid("a request ID is needed, of at most 128 bytes")
	}
	role, ok := registryRoles[r.GetRole()]
	if !ok {
		return fail("a role is needed")
	}
	if role == registry.RoleHost && s.cfg.ClosedToHosts {
		return &frameError{code: pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED, msg: "this relay takes no new hosts but those its operator adds", requestID: requestID}
	}
	lifetime := DefaultTokenLifetime
	if r.GetLifetime() != nil {
		lifetime = r.GetLifetime().AsDuration()
	}
	if lifetime <= 0 || lifetime > MaxTokenLifetime {
		return fail("a token's lifetime is more than nothing and at most 24 hours")
	}
	now := time.Now()
	token, err := s.cfg.Registry.IssueToken(role, r.GetLabel(), lifetime, now)
	switch {
	case errors.Is(err, registry.ErrLabelTooLong):
		return fail(err.Error())
	case err != nil:
		s.log.Error("cannot issue a token", "err", err)
		return &frameError{code: pb.ErrorCode_ERROR_CODE_INTERNAL, msg: "registry unavailable", requestID: requestID}
	}
	s.log.Info("token issued", "role", role, "label", r.GetLabel(), "valid", lifetime, "by", c.label)
	c.queue(&pb.Frame{Body: &pb.Frame_TokenIssued{TokenIssued: &pb.TokenIssued{RequestId: requestID, Token: token, ExpiresAt: timestamppb.New(now.Add(lifetime))}}})
	return nil
}

// setPush registers a client for push with handle, or unregisters it when
// handle is empty, and answers it.
func (s *Server) setPush(c *conn, requestID, handle string, register bool) *frameError {
	if requestID == "" || len(requestID) > MaxIDBytes {
		return invalid("a request ID is needed, of at most 128 bytes")
	}
	if register && handle == "" {
		return &frameError{code: pb.ErrorCode_ERROR_CODE_INVALID, msg: registry.ErrHandleSize.Error(), requestID: requestID}
	}
	_, err := s.cfg.Registry.SetPush(c.key, handle)
	switch {
	case errors.Is(err, registry.ErrHandleSize):
		return &frameError{code: pb.ErrorCode_ERROR_CODE_INVALID, msg: err.Error(), requestID: requestID}
	case err != nil:
		// A key removed meanwhile is closing; either way, nothing changed.
		s.log.Error("cannot change a push registration", "label", c.label, "err", err)
		return &frameError{code: pb.ErrorCode_ERROR_CODE_INTERNAL, msg: "registry unavailable", requestID: requestID}
	}
	if register {
		s.log.Info("registered for push", "label", c.label)
	} else {
		s.log.Info("unregistered for push", "label", c.label)
	}
	_ = s.reloadRegistry(true)
	c.queue(&pb.Frame{Body: &pb.Frame_PushChanged{PushChanged: &pb.PushChanged{RequestId: requestID}}})
	return nil
}

// registerReadKey makes a key the client's read-only key, and answers it.
func (s *Server) registerReadKey(c *conn, r *pb.RegisterReadKey) *frameError {
	requestID := r.GetRequestId()
	fail := func(code pb.ErrorCode, msg string) *frameError {
		return &frameError{code: code, msg: msg, requestID: requestID}
	}
	if requestID == "" || len(requestID) > MaxIDBytes {
		return invalid("a request ID is needed, of at most 128 bytes")
	}
	if len(r.GetPublicKey()) != ed25519.PublicKeySize {
		return fail(pb.ErrorCode_ERROR_CODE_INVALID, "public key must be 32 bytes")
	}
	_, err := s.cfg.Registry.SetReadKey(c.key, r.GetPublicKey())
	switch {
	case errors.Is(err, registry.ErrKeyTaken):
		return fail(pb.ErrorCode_ERROR_CODE_INVALID, err.Error())
	case err != nil:
		s.log.Error("cannot register a read-only key", "label", c.label, "err", err)
		return fail(pb.ErrorCode_ERROR_CODE_INTERNAL, "registry unavailable")
	}
	s.log.Info("read-only key registered", "label", c.label, "key", registry.EncodeKey(r.GetPublicKey()))
	// One replaced is disconnected by the reload, before the answer.
	_ = s.reloadRegistry(true)
	c.queue(&pb.Frame{Body: &pb.Frame_KeyChanged{KeyChanged: &pb.KeyChanged{RequestId: requestID}}})
	return nil
}
