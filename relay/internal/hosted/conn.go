// A device's WebSocket: its queue of frames out, its write loop, and the
// errors sent on it. As package server's, for v1alpha2's frames.

package hosted

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

type conn struct {
	ws *websocket.Conn
	// The peer's address for the caps (proxy.ClientAddr), and as logged.
	addr   string
	remote string
	key    []byte
	// CheckInvite frames sent (invites.go).
	inviteChecks atomic.Int32
	// The login's challenge, which an attestation binds (AttestContext).
	nonce []byte
	// Logged in to a locked account (lock.go): it may only renew or
	// delete it. Under Server.mu.
	locked bool
	// The account and the key's role in it; nil and unspecified when
	// logged in without an account. Under Server.mu.
	acct *account
	role pb.DeviceRole
	// The list's entry the key logged in by: its own, or for a read-only
	// key its phone's. Under Server.mu.
	device *pb.Device
	// A version of the list removed its device: nothing from the
	// connection is taken, and it closes once the List frame telling it
	// has been written. Under Server.mu.
	removed bool
	// Set once that List is queued: nothing more is.
	dropQueue atomic.Bool
	// A computer's pi process (Hello.instance_id); empty for any other
	// key.
	instance string
	// When it logged in, in the server's order: the newest connection of
	// a process takes its new channels.
	seq uint64
	// Sessions this connection has; under Server.mu.
	sessions int
	// Its channels, by ID; under Server.mu.
	channels map[uint64]*channel
	// Announcements (a bucket refilled at a fixed rate), channel opens
	// this minute and notice fetches this minute; under Server.mu.
	announceTokens float64
	announceAt     time.Time
	opens, fetches counter
	// A join this connection waits for, or takes part in; under Server.mu.
	wait   *joinWait
	joinID string
	// Closes a connection without an account that is in no wait or join;
	// under Server.mu.
	idle *time.Timer
	send chan outFrame
	// Bytes in send, and the most allowed.
	queued    atomic.Int64
	maxQueued int64
	// done is closed when the connection is told to end, closed when its
	// close handshake has finished.
	done      chan struct{}
	closed    chan struct{}
	closeOnce sync.Once
}

// close ends the connection. The close handshake runs in the background:
// it can take seconds with a peer that has stopped reading, and callers
// may hold the server's lock.
func (c *conn) close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		close(c.done)
		go func() {
			c.ws.Close(code, reason)
			close(c.closed)
		}()
	})
}

// closeAfterFlush closes the connection once what is queued has been
// written, or after five seconds.
func (c *conn) closeAfterFlush(code websocket.StatusCode, reason string) {
	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for c.queued.Load() > 0 && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		c.close(code, reason)
	}()
}

func (c *conn) writeLoop(ctx context.Context, pingEvery time.Duration) {
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ctx.Done():
			return
		case o := <-c.send:
			wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := c.ws.Write(wctx, websocket.MessageBinary, o.b)
			cancel()
			c.queued.Add(-int64(len(o.b)))
			o.unqueued()
			if err != nil {
				c.close(websocket.StatusGoingAway, "write failed")
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			err := c.ws.Ping(pctx)
			cancel()
			if err != nil {
				c.close(websocket.StatusGoingAway, "ping failed")
				return
			}
		}
	}
}

// queue sends f to the peer, disconnecting it when it cannot keep up.
func (c *conn) queue(f *pb.Frame) {
	b, err := proto.Marshal(f)
	if err != nil {
		return
	}
	c.queueBytes(b)
}

// outFrame is an encoded frame queued, and the count of a channel's bytes
// queued that it is part of, if any.
type outFrame struct {
	b       []byte
	channel *queued
}

// queued counts the bytes and frames queued toward one end of a channel.
type queued struct{ bytes, frames atomic.Int64 }

// unqueued lowers its channel's counts by o, once o is written or
// dropped.
func (o outFrame) unqueued() {
	if o.channel != nil {
		o.channel.bytes.Add(-int64(len(o.b)))
		o.channel.frames.Add(-1)
	}
}

// queueBytes sends an encoded frame, which callers may share between
// connections: it is never modified.
func (c *conn) queueBytes(b []byte) { c.queueOut(outFrame{b: b}) }

// queueOut queues a frame, disconnecting the peer when its queue is full.
// A channel's count, already raised by the frame's length, is lowered
// again once it is written, or now if it is not queued.
func (c *conn) queueOut(o outFrame) {
	unqueued := o.unqueued
	if c.dropQueue.Load() {
		unqueued()
		return
	}
	if c.queued.Add(int64(len(o.b))) > c.maxQueued {
		c.queued.Add(-int64(len(o.b)))
		unqueued()
		c.close(websocket.StatusTryAgainLater, "too slow")
		return
	}
	select {
	case <-c.done:
		c.queued.Add(-int64(len(o.b)))
		unqueued()
	case c.send <- o:
	default:
		c.queued.Add(-int64(len(o.b)))
		unqueued()
		c.close(websocket.StatusTryAgainLater, "too slow")
	}
}

// fail reports an error to the peer and closes the connection. Only for
// the connection's own goroutine, outside the server's lock.
func (c *conn) fail(ctx context.Context, code pb1.ErrorCode, msg string) error {
	if b, err := proto.Marshal(errorFrame(code, msg, "")); err == nil {
		wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		c.ws.Write(wctx, websocket.MessageBinary, b)
		cancel()
	}
	c.close(websocket.StatusPolicyViolation, msg)
	return errors.New(msg)
}

func errorFrame(code pb1.ErrorCode, msg, requestID string) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_Error{Error: &pb1.Error{Code: code, Message: msg, RequestId: requestID}}}
}

type frameError struct {
	code pb1.ErrorCode
	msg  string
	// The request it answers, if any.
	requestID string
}

func (e *frameError) frame() *pb.Frame { return errorFrame(e.code, e.msg, e.requestID) }

// withID marks the error as the answer to a request; nil stays nil.
func (e *frameError) withID(id string) *frameError {
	if e == nil {
		return nil
	}
	c := *e
	c.requestID = id
	return &c
}

func denied(msg string) *frameError {
	return &frameError{code: pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED, msg: msg}
}

func invalid(msg string) *frameError {
	return &frameError{code: pb1.ErrorCode_ERROR_CODE_INVALID, msg: msg}
}

func internal() *frameError {
	return &frameError{code: pb1.ErrorCode_ERROR_CODE_INTERNAL, msg: "internal error"}
}

func rateLimited(msg string) *frameError {
	return &frameError{code: pb1.ErrorCode_ERROR_CODE_RATE_LIMITED, msg: msg}
}

var errNoSession = &frameError{code: pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no such session"}
