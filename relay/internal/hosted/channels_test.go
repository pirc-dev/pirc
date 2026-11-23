package hosted

// Channels: a client and a pi process joined through the relay.

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"

	"github.com/coder/websocket"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

func openFrame(id string, host dev, instance string, msg []byte) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_OpenChannel{OpenChannel: &pb.OpenChannel{RequestId: id, HostKey: host.pub, InstanceId: instance, Message: msg}}}
}

func msgFrame(ch uint64, msg []byte) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_ChannelMessage{ChannelMessage: &pb.ChannelMessage{ChannelId: ch, Message: msg}}}
}

// filled is n bytes of b.
func filled(b byte, n int) []byte { return bytes.Repeat([]byte{b}, n) }

// open opens a channel from c to the process, and returns its ID as the
// client and the process were told it.
func open(t *testing.T, c, proc *client, host dev, instance string) uint64 {
	t.Helper()
	msg := filled(1, OpenMessageBytes)
	c.send(openFrame("o", host, instance, msg))
	f := c.until("ChannelOpened", func(f *pb.Frame) bool { return f.GetChannelOpened() != nil || f.GetError().GetRequestId() == "o" })
	if f.GetError() != nil {
		t.Fatalf("open: %v", f.GetError())
	}
	id := f.GetChannelOpened().ChannelId
	o := proc.until("OpenChannel", func(f *pb.Frame) bool { return f.GetOpenChannel() != nil }).GetOpenChannel()
	// The process is given the ID and the message only: who opened it
	// is Noise's to say.
	if o.ChannelId != id || !bytes.Equal(o.Message, msg) || o.RequestId != "" || len(o.HostKey) != 0 || o.InstanceId != "" {
		t.Fatalf("the process was given %v", o)
	}
	return id
}

func gotMessage(c *client) *pb.ChannelMessage {
	c.t.Helper()
	return c.until("ChannelMessage", func(f *pb.Frame) bool { return f.GetChannelMessage() != nil }).GetChannelMessage()
}

func gotClose(c *client, id uint64) pb1.ErrorCode {
	c.t.Helper()
	return c.until("CloseChannel", func(f *pb.Frame) bool { return f.GetCloseChannel() != nil && f.GetCloseChannel().ChannelId == id }).GetCloseChannel().Code
}

func TestChannels(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	id := open(t, sa.b, sa.hc, sa.hst, "i1")

	// Both ways, at each bound, in order.
	for _, n := range []int{MinChannelMessageBytes, MaxChannelMessageBytes} {
		sa.hc.send(msgFrame(id, filled(2, n)))
		if m := gotMessage(sa.b); m.ChannelId != id || len(m.Message) != n {
			t.Errorf("to the client: %d bytes", len(m.Message))
		}
		sa.b.send(msgFrame(id, filled(3, n)))
		if m := gotMessage(sa.hc); m.ChannelId != id || len(m.Message) != n {
			t.Errorf("to the process: %d bytes", len(m.Message))
		}
	}
	for i := 0; i < 300; i++ {
		sa.b.send(msgFrame(id, binary.BigEndian.AppendUint64(filled(0, 16), uint64(i))))
	}
	for i := 0; i < 300; i++ {
		if m := gotMessage(sa.hc); binary.BigEndian.Uint64(m.Message[16:]) != uint64(i) {
			t.Fatalf("message %d came as %d", i, binary.BigEndian.Uint64(m.Message[16:]))
		}
	}
	// Past each bound, refused; the channel stays.
	for _, n := range []int{MinChannelMessageBytes - 1, MaxChannelMessageBytes + 1} {
		sa.b.send(msgFrame(id, filled(4, n)))
		if e := sa.b.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
			t.Errorf("%d bytes: %v", n, e)
		}
	}
	sa.hc.quiet("a message past a bound", func(f *pb.Frame) bool { return f.GetChannelMessage() != nil })
	// Another client cannot write to it.
	sa.p.send(msgFrame(id, filled(5, 20)))
	if e := sa.p.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND {
		t.Errorf("another client's message: %v", e)
	}
	sa.hc.quiet("another client's message", func(f *pb.Frame) bool { return f.GetChannelMessage() != nil })

	// Closed by the client: the process is told its code.
	sa.b.send(&pb.Frame{Body: &pb.Frame_CloseChannel{CloseChannel: &pb.CloseChannel{ChannelId: id, Code: pb1.ErrorCode_ERROR_CODE_INVALID}}})
	if c := gotClose(sa.hc, id); c != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("closed by the client: %v", c)
	}
	sa.b.send(msgFrame(id, filled(6, 20)))
	if e := sa.b.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND {
		t.Errorf("after the close: %v", e)
	}
	// Closed by the process.
	id2 := open(t, sa.p, sa.hc, sa.hst, "i1")
	if id2 <= id {
		t.Errorf("IDs %d then %d", id, id2)
	}
	sa.hc.send(&pb.Frame{Body: &pb.Frame_CloseChannel{CloseChannel: &pb.CloseChannel{ChannelId: id2}}})
	gotClose(sa.p, id2)
}

func TestChannelRefusals(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	other := newDev(8)
	otherID := h.signUp(other)
	oc, _ := h.login(other, otherID)

	for _, c := range []struct {
		about string
		from  *client
		f     *pb.Frame
		code  pb1.ErrorCode
	}{
		{"95 bytes", sa.b, openFrame("a", sa.hst, "i1", filled(1, OpenMessageBytes-1)), pb1.ErrorCode_ERROR_CODE_INVALID},
		{"97 bytes", sa.b, openFrame("a", sa.hst, "i1", filled(1, OpenMessageBytes+1)), pb1.ErrorCode_ERROR_CODE_INVALID},
		{"no instance", sa.b, openFrame("a", sa.hst, "", filled(1, OpenMessageBytes)), pb1.ErrorCode_ERROR_CODE_INVALID},
		{"another instance", sa.b, openFrame("a", sa.hst, "i2", filled(1, OpenMessageBytes)), pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND},
		{"a client's key", sa.b, openFrame("a", sa.phone, "i1", filled(1, OpenMessageBytes)), pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND},
		{"from another account", oc, openFrame("a", sa.hst, "i1", filled(1, OpenMessageBytes)), pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND},
		{"from a computer", sa.hc, openFrame("a", sa.hst, "i1", filled(1, OpenMessageBytes)), pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED},
	} {
		c.from.send(c.f)
		if e := c.from.errorFor("a"); e.Code != c.code {
			t.Errorf("%s: %v", c.about, e)
		}
	}
	sa.hc.quiet("an open channel", func(f *pb.Frame) bool { return f.GetOpenChannel() != nil })

	// The instance ID at login: required from a computer, 1 to 128
	// bytes, and from nothing else.
	for _, c := range []struct {
		d        dev
		instance string
	}{{sa.hst, ""}, {sa.hst, string(filled('i', MaxIDBytes+1))}, {sa.browser, "i1"}, {newDev(7), "i1"}} {
		acct := sa.ta.id
		if c.d.pub.Equal(newDev(7).pub) {
			acct = nil
		}
		if _, f := h.loginWith(c.d, acct, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2, 0, c.instance); f.GetError().GetCode() != pb1.ErrorCode_ERROR_CODE_INVALID {
			t.Errorf("logging in with instance %q: %v", c.instance, f)
		}
	}
	if _, f := h.loginWith(sa.hst, sa.ta.id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2, 0, string(filled('i', MaxIDBytes))); f.GetWelcome() == nil {
		t.Errorf("a 128-byte instance ID: %v", f)
	}
}

// A newer connection of the process takes new channels; the older keeps
// its own until it closes.
func TestChannelTakeover(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	old := open(t, sa.b, sa.hc, sa.hst, "i1")
	hc2, _ := h.login(sa.hst, sa.ta.id)
	open(t, sa.b, hc2, sa.hst, "i1")
	sa.hc.quiet("a new channel on the older connection", func(f *pb.Frame) bool { return f.GetOpenChannel() != nil })
	sa.b.send(msgFrame(old, filled(1, 20)))
	if m := gotMessage(sa.hc); m.ChannelId != old {
		t.Errorf("the older channel: %v", m)
	}
	// The older connection goes: its channel closes, SESSION_GONE.
	sa.hc.ws.Close(websocket.StatusNormalClosure, "")
	if c := gotClose(sa.b, old); c != pb1.ErrorCode_ERROR_CODE_SESSION_GONE {
		t.Errorf("the process gone: %v", c)
	}
	// A client gone closes its channels on the process.
	id := open(t, sa.p, hc2, sa.hst, "i1")
	sa.p.ws.Close(websocket.StatusNormalClosure, "")
	if c := gotClose(hc2, id); c != pb1.ErrorCode_ERROR_CODE_SESSION_GONE {
		t.Errorf("the client gone: %v", c)
	}
}

// A process that sends nothing within ChannelReplyTimeout: the channel
// closes, TIMEOUT, at both ends; one that answers keeps it.
func TestChannelFirstReply(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.ChannelReplyTimeout = 200 * time.Millisecond })
	sa := newSealedAccount(h)
	silent := open(t, sa.b, sa.hc, sa.hst, "i1")
	answered := open(t, sa.p, sa.hc, sa.hst, "i1")
	// The client's messages are not the process's reply.
	sa.b.send(msgFrame(silent, filled(3, 20)))
	gotMessage(sa.hc)
	sa.hc.send(msgFrame(answered, filled(1, 48)))
	gotMessage(sa.p)
	for _, c := range []*client{sa.b, sa.hc} {
		if code := gotClose(c, silent); code != pb1.ErrorCode_ERROR_CODE_TIMEOUT {
			t.Errorf("unanswered: %v", code)
		}
	}
	time.Sleep(300 * time.Millisecond)
	sa.p.send(msgFrame(answered, filled(2, 20)))
	if m := gotMessage(sa.hc); m.ChannelId != answered {
		t.Errorf("the answered channel: %v", m)
	}
}

// Past the bytes queued toward one end of a channel, the channel
// closes, RATE_LIMITED, and the connection stays.
func TestChannelQueueCap(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	id := open(t, sa.b, sa.hc, sa.hst, "i1")
	sa.hc.send(msgFrame(id, filled(1, 48)))
	gotMessage(sa.b)
	sa.hc.hold.Lock()
	closed := false
	for i := 0; i < 160 && !closed; i++ {
		sa.b.send(msgFrame(id, filled(2, MaxChannelMessageBytes)))
		for {
			f, err := sa.b.read(time.Millisecond)
			if err != nil {
				break
			}
			if f.GetCloseChannel().GetChannelId() == id {
				if f.GetCloseChannel().Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
					t.Errorf("closed %v", f.GetCloseChannel())
				}
				closed = true
			}
		}
	}
	sa.hc.hold.Unlock()
	if !closed {
		t.Fatal("the channel was not closed")
	}
	// The process's connection is still up: it is told of the close, and
	// takes a new channel.
	if c := gotClose(sa.hc, id); c != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Errorf("the process was told %v", c)
	}
	open(t, sa.b, sa.hc, sa.hst, "i1")
}

func TestChannelCaps(t *testing.T) {
	t.Run("per client", func(t *testing.T) {
		h := newHarness(t, func(c *Config) { c.MaxChannelsPerClient = 2 })
		sa := newSealedAccount(h)
		open(t, sa.b, sa.hc, sa.hst, "i1")
		open(t, sa.b, sa.hc, sa.hst, "i1")
		sa.b.send(openFrame("x", sa.hst, "i1", filled(1, OpenMessageBytes)))
		if e := sa.b.errorFor("x"); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
			t.Errorf("a third: %v", e)
		}
		open(t, sa.p, sa.hc, sa.hst, "i1")
	})
	t.Run("per process", func(t *testing.T) {
		h := newHarness(t, func(c *Config) { c.MaxChannelsPerProcess = 2 })
		sa := newSealedAccount(h)
		open(t, sa.b, sa.hc, sa.hst, "i1")
		open(t, sa.p, sa.hc, sa.hst, "i1")
		sa.p2.send(openFrame("x", sa.hst, "i1", filled(1, OpenMessageBytes)))
		if e := sa.p2.errorFor("x"); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
			t.Errorf("a third: %v", e)
		}
	})
	t.Run("opens a minute", func(t *testing.T) {
		h := newHarness(t, func(c *Config) { c.MaxChannelOpensPerMinute = 2 })
		sa := newSealedAccount(h)
		for i := 0; i < 2; i++ {
			id := open(t, sa.b, sa.hc, sa.hst, "i1")
			sa.b.send(&pb.Frame{Body: &pb.Frame_CloseChannel{CloseChannel: &pb.CloseChannel{ChannelId: id}}})
			gotClose(sa.hc, id)
		}
		sa.b.send(openFrame("x", sa.hst, "i1", filled(1, OpenMessageBytes)))
		if e := sa.b.errorFor("x"); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
			t.Errorf("a third this minute: %v", e)
		}
	})
}

// A device removed: its channels close, PERMISSION_DENIED, on the other
// end.
func TestChannelRemoval(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	id := open(t, sa.b, sa.hc, sa.hst, "i1")
	keep := open(t, sa.p2, sa.hc, sa.hst, "i1")
	h.publish(sa.ta.id, sa.ta.next(phoneEntry(sa.phone), phoneEntry(sa.phone2), entry(sa.hst, RoleComputer)))
	if c := gotClose(sa.hc, id); c != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("the browser removed: %v", c)
	}
	h.publish(sa.ta.id, sa.ta.next(phoneEntry(sa.phone), phoneEntry(sa.phone2)))
	if c := gotClose(sa.p2, keep); c != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("the computer removed: %v", c)
	}
}

// Small messages reach the frames queued toward one end of a channel
// long before its bytes: the channel closes, RATE_LIMITED, and the
// connection stays.
func TestChannelQueueCapSmallMessages(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	id := open(t, sa.b, sa.hc, sa.hst, "i1")
	sa.hc.send(msgFrame(id, filled(1, 48)))
	gotMessage(sa.b)
	sa.hc.hold.Lock()
	closed := false
	for i := 0; i < 200000 && !closed; i++ {
		sa.b.send(msgFrame(id, filled(2, MinChannelMessageBytes)))
		if i%500 != 0 {
			continue
		}
		for {
			f, err := sa.b.read(time.Millisecond)
			if err != nil {
				break
			}
			if f.GetCloseChannel().GetChannelId() == id {
				if f.GetCloseChannel().Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
					t.Errorf("closed %v", f.GetCloseChannel())
				}
				closed = true
			}
		}
	}
	sa.hc.hold.Unlock()
	if !closed {
		t.Fatal("the channel was not closed")
	}
	if c := gotClose(sa.hc, id); c != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Errorf("the process was told %v", c)
	}
	open(t, sa.b, sa.hc, sa.hst, "i1")
}
