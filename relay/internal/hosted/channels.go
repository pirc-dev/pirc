// Channels (docs/e2e.md, section 4): one client and one pi process of a
// computer of the same account, joined by the relay, which passes their
// Noise messages on unread and in order, and keeps nothing for an end
// that is gone.

package hosted

import (
	"bytes"
	"crypto/ed25519"
	"time"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

const (
	// Noise IK's first message, with no payload.
	OpenMessageBytes = 96
	// A Noise message: a MAC at least, 65,535 bytes at most.
	MinChannelMessageBytes = 16
	MaxChannelMessageBytes = 65535
)

type channel struct {
	id           uint64
	client, proc *conn
	// The process has sent its first message.
	replied bool
	timer   *time.Timer
	// Bytes queued toward each end.
	toClient, toProc queued
}

// other is the end of ch that is not c.
func (ch *channel) other(c *conn) *conn {
	if c == ch.client {
		return ch.proc
	}
	return ch.client
}

// queuedToward counts what is queued toward end c.
func (ch *channel) queuedToward(c *conn) *queued {
	if c == ch.client {
		return &ch.toClient
	}
	return &ch.toProc
}

func closeFrame(id uint64, code pb1.ErrorCode) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_CloseChannel{CloseChannel: &pb.CloseChannel{ChannelId: id, Code: code}}}
}

// openChannel opens a channel from client c to the newest connection of
// a process of a computer of its account. Under s.mu.
func (s *Server) openChannel(c *conn, o *pb.OpenChannel) *frameError {
	if len(o.GetHostKey()) != ed25519.PublicKeySize || o.GetInstanceId() == "" || len(o.GetInstanceId()) > MaxIDBytes {
		return invalid("a channel is opened to a computer's key and an instance ID")
	}
	if len(o.GetMessage()) != OpenMessageBytes {
		return invalid("a channel's first message is 96 bytes")
	}
	if !countIn(&c.opens, s.cfg.MaxChannelOpensPerMinute, s.cfg.Now(), time.Minute) {
		return rateLimited("too many channels opened; try again in a minute")
	}
	if len(c.channels) >= s.cfg.MaxChannelsPerClient {
		return rateLimited("too many channels on this connection")
	}
	var proc *conn
	for p := range c.acct.conns {
		if p.role == pb.DeviceRole_DEVICE_ROLE_HOST && !p.removed && p.instance == o.GetInstanceId() &&
			bytes.Equal(p.key, o.GetHostKey()) && (proc == nil || p.seq > proc.seq) {
			proc = p
		}
	}
	if proc == nil {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no such process connected"}
	}
	if len(proc.channels) >= s.cfg.MaxChannelsPerProcess {
		return rateLimited("too many channels to this process")
	}
	s.lastChannel++
	ch := &channel{id: s.lastChannel, client: c, proc: proc}
	c.channels[ch.id] = ch
	proc.channels[ch.id] = ch
	ch.timer = time.AfterFunc(s.cfg.ChannelReplyTimeout, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if c.channels[ch.id] == ch && !ch.replied {
			s.closeChannelLocked(ch, pb1.ErrorCode_ERROR_CODE_TIMEOUT, nil)
		}
	})
	c.queue(&pb.Frame{Body: &pb.Frame_ChannelOpened{ChannelOpened: &pb.ChannelOpened{RequestId: o.GetRequestId(), ChannelId: ch.id}}})
	proc.queue(&pb.Frame{Body: &pb.Frame_OpenChannel{OpenChannel: &pb.OpenChannel{ChannelId: ch.id, Message: o.GetMessage()}}})
	return nil
}

// channelMessage passes a message on to the channel's other end. Under
// s.mu.
func (s *Server) channelMessage(c *conn, m *pb.ChannelMessage) *frameError {
	ch := c.channels[m.GetChannelId()]
	if ch == nil {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no such channel"}
	}
	if n := len(m.GetMessage()); n < MinChannelMessageBytes || n > MaxChannelMessageBytes {
		return invalid("a channel message is 16 to 65,535 bytes")
	}
	if c == ch.proc && !ch.replied {
		ch.replied = true
		ch.timer.Stop()
	}
	b, e := s.encode(&pb.Frame{Body: &pb.Frame_ChannelMessage{ChannelMessage: &pb.ChannelMessage{ChannelId: ch.id, Message: m.GetMessage()}}})
	if e != nil {
		return e
	}
	to := ch.other(c)
	n := ch.queuedToward(to)
	// Small messages fill the connection's frame slots long before its
	// bytes: both are capped per channel.
	if n.bytes.Add(int64(len(b))) > int64(s.cfg.MaxChannelQueuedBytes) || n.frames.Add(1) > int64(s.cfg.MaxChannelQueuedFrames) {
		n.bytes.Add(-int64(len(b)))
		n.frames.Add(-1)
		s.closeChannelLocked(ch, pb1.ErrorCode_ERROR_CODE_RATE_LIMITED, nil)
		return nil
	}
	to.queueOut(outFrame{b: b, channel: n})
	return nil
}

// closeChannelFrom passes either end's CloseChannel on to the other.
// Under s.mu.
func (s *Server) closeChannelFrom(c *conn, cl *pb.CloseChannel) {
	if ch := c.channels[cl.GetChannelId()]; ch != nil {
		s.closeChannelLocked(ch, cl.GetCode(), c)
	}
}

// closeChannelLocked ends a channel and tells its ends, but for `by`,
// which ended it or is gone. Under s.mu.
func (s *Server) closeChannelLocked(ch *channel, code pb1.ErrorCode, by *conn) {
	ch.timer.Stop()
	delete(ch.client.channels, ch.id)
	delete(ch.proc.channels, ch.id)
	for _, end := range []*conn{ch.client, ch.proc} {
		if end != by {
			end.queue(closeFrame(ch.id, code))
		}
	}
}

// closeChannelsLocked ends every channel of c, telling the other ends.
// Under s.mu.
func (s *Server) closeChannelsLocked(c *conn, code pb1.ErrorCode) {
	for _, ch := range c.channels {
		s.closeChannelLocked(ch, code, c)
	}
}
