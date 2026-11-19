package hosted

import (
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/coder/websocket"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// An account holds at most 256 hosts and 32 clients, each client with its
// read-only key (docs/e2e.md, section 3): the relay refuses a version with
// more, whichever client signs it.
func TestCaps(t *testing.T) {
	h := newHarness(t, nil)
	phone := newDev(1)
	ch := h.signUp(phone)
	p, _ := h.login(phone, ch.id)
	devs := func(role pb.DeviceRole, n int, seed byte) []*pb.Device {
		var out []*pb.Device
		for i := 0; i < n; i++ {
			out = append(out, device(role, devFrom([]byte{seed, byte(i), byte(i >> 8)}), phone.pub, nil))
		}
		return out
	}
	full := append(devs(pb.DeviceRole_DEVICE_ROLE_HOST, 256, 10), devs(pb.DeviceRole_DEVICE_ROLE_CLIENT, 31, 20)...)
	for i := 0; i < 32; i++ {
		full = append(full, device(pb.DeviceRole_DEVICE_ROLE_READ_ONLY, devFrom([]byte{30, byte(i)}), phone.pub, phone.pub))
	}
	p.publish(ch, ch.next(phone, full), "full")

	for _, c := range []struct {
		what string
		add  *pb.Device
	}{
		{"a 257th host", device(pb.DeviceRole_DEVICE_ROLE_HOST, devFrom([]byte{40}), phone.pub, nil)},
		{"a 33rd client", device(pb.DeviceRole_DEVICE_ROLE_CLIENT, devFrom([]byte{41}), phone.pub, nil)},
		{"a 33rd read-only key", device(pb.DeviceRole_DEVICE_ROLE_READ_ONLY, devFrom([]byte{42}), phone.pub, phone.pub)},
	} {
		p.send(&pb.Frame{Body: &pb.Frame_PublishVersion{PublishVersion: &pb.PublishVersion{RequestId: c.what, Version: ch.next(phone, []*pb.Device{c.add})}}})
		if e := p.errorFor(c.what); code(e) != pb1.ErrorCode_ERROR_CODE_INVALID {
			t.Errorf("%s: %v, want INVALID", c.what, e)
		}
	}
}

// devFrom is a test device whose key's seed is the hash of b.
func devFrom(b []byte) dev {
	seed := sha256.Sum256(b)
	priv := ed25519.NewKeyFromSeed(seed[:])
	return dev{pub: priv.Public().(ed25519.PublicKey), priv: priv}
}

// A database made before subscriptions had renews gets the column.
func TestStoreAddsColumns(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "hosted.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE subscriptions (account BLOB NOT NULL, kind TEXT NOT NULL, ident BLOB NOT NULL, expires_ms INTEGER NOT NULL,
		trial INTEGER NOT NULL, grace INTEGER NOT NULL, sandbox INTEGER NOT NULL, checked_ms INTEGER NOT NULL, lapsed INTEGER NOT NULL DEFAULT 0,
		reason TEXT NOT NULL DEFAULT '', lapsed_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, kind, ident));
		INSERT INTO subscriptions (account, kind, ident, expires_ms, trial, grace, sandbox, checked_ms) VALUES (x'01', 'app-store', x'02', 5, 0, 0, 0, 1)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	subs, err := s.Subscriptions([]byte{1})
	if err != nil || len(subs) != 1 || subs[0].Sub.Renews {
		t.Fatalf("%v %v", subs, err)
	}
	if err := s.AddSubscription([]byte{1}, Subscription{Kind: "app-store", Ident: []byte{2}, Renews: true}, 2); err != nil {
		t.Fatal(err)
	}
	if subs, _ := s.Subscriptions([]byte{1}); !subs[0].Sub.Renews {
		t.Fatal("renews not kept")
	}
}

// A client that leaves is answered before the relay closes it for the
// key it no longer has: else it cannot tell its version was taken.
func TestLeaveAnswered(t *testing.T) {
	h := newHarness(t, nil)
	phone, tablet := newDev(1), newDev(2)
	ch := h.signUp(phone)
	p, _ := h.login(phone, ch.id)
	p.publish(ch, ch.next(phone, []*pb.Device{device(pb.DeviceRole_DEVICE_ROLE_CLIENT, tablet, phone.pub, nil)}), "add")
	for i := 0; i < 20; i++ {
		tc, _ := h.login(tablet, ch.id)
		leave := ch.next(tablet, nil, tablet)
		tc.send(&pb.Frame{Body: &pb.Frame_PublishVersion{PublishVersion: &pb.PublishVersion{RequestId: "leave", Version: leave}}})
		tc.done("leave")
		if got := tc.closedWith(); got != websocket.StatusPolicyViolation {
			t.Fatalf("closed with %v, want 1008", got)
		}
		ch.take(leave)
		p.publish(ch, ch.next(phone, []*pb.Device{device(pb.DeviceRole_DEVICE_ROLE_CLIENT, tablet, phone.pub, nil)}), "back")
	}
}
