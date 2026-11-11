// Hosts awaiting approval, as clients see and decide on them: any
// registered client may (docs/design.md, 5.3).

package server

import (
	"bytes"
	"crypto/ed25519"
	"errors"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	"pirc.dev/relay/internal/registry"
)

// pendingFrame is the PendingHosts frame for a registry snapshot, encoded.
func (s *Server) pendingFrame(d *registry.Data) []byte {
	var hosts []*pb.PendingHost
	for _, q := range d.Pending(s.cfg.Now()) {
		pub, err := registry.DecodeKey(q.PublicKey)
		if err != nil {
			continue
		}
		hosts = append(hosts, &pb.PendingHost{
			PublicKey: pub,
			Label:     q.Label,
			Software:  q.Software,
			Remote:    q.Remote,
			FirstSeen: timestamppb.New(q.FirstSeen),
		})
	}
	b, _ := proto.Marshal(&pb.Frame{Body: &pb.Frame_PendingHosts{PendingHosts: &pb.PendingHosts{Hosts: hosts}}})
	return b
}

// pushPendingLocked sends the list to its watchers when it changed since
// it was last sent: on every registry reload, which also notices a request
// expiring. Under s.mu.
func (s *Server) pushPendingLocked() {
	if s.reg == nil {
		return
	}
	b := s.pendingFrame(s.reg)
	if bytes.Equal(b, s.pendingSent) {
		return
	}
	s.pendingSent = b
	for c := range s.watchers {
		c.queueBytes(b)
	}
}

func (s *Server) watchPending(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.watchers[c] = struct{}{}
	if s.reg == nil {
		return
	}
	if s.pendingSent == nil {
		s.pendingSent = s.pendingFrame(s.reg)
	}
	c.queueBytes(s.pendingSent)
}

// decide approves or rejects a waiting host for a client, and answers it.
func (s *Server) decide(c *conn, requestID string, pub []byte, approve bool, label string) *frameError {
	fail := func(code pb.ErrorCode, msg string) *frameError {
		return &frameError{code: code, msg: msg, requestID: requestID}
	}
	if requestID == "" || len(requestID) > MaxIDBytes {
		return invalid("a request ID is needed, of at most 128 bytes")
	}
	if len(pub) != ed25519.PublicKeySize {
		return fail(pb.ErrorCode_ERROR_CODE_INVALID, "public key must be 32 bytes")
	}
	key := registry.EncodeKey(pub)
	now := s.cfg.Now()
	var err error
	if approve {
		var k registry.Key
		k, err = s.cfg.Registry.Approve(key, label, now)
		if err == nil {
			s.log.Info("host approved", "label", k.Label, "key", key, "by", c.label)
		}
	} else {
		var q registry.Request
		q, err = s.cfg.Registry.Reject(key, now)
		if err == nil {
			s.log.Info("host rejected", "label", q.Label, "key", key, "by", c.label)
		}
	}
	switch {
	case errors.Is(err, registry.ErrNoRequest), errors.Is(err, registry.ErrRegistered), errors.Is(err, registry.ErrKeyTaken), errors.Is(err, registry.ErrLabelTooLong):
		return fail(pb.ErrorCode_ERROR_CODE_INVALID, err.Error())
	case err != nil:
		s.log.Error("cannot decide on a host", "key", key, "err", err)
		return fail(pb.ErrorCode_ERROR_CODE_INTERNAL, "registry unavailable")
	}
	// The list without it goes to every watcher, then the answer: a client
	// that sees the answer has the list already.
	_ = s.reloadRegistry(true)
	c.queue(&pb.Frame{Body: &pb.Frame_HostDecided{HostDecided: &pb.HostDecided{RequestId: requestID}}})
	return nil
}
