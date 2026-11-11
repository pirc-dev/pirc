// A peer's WebSocket: its queue of frames out, its write and read loops.

package server

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	"pirc.dev/relay/internal/registry"
)

type conn struct {
	ws *websocket.Conn
	// The peer's address: as the HTTP server saw it, or as a trusted proxy
	// reported it (proxy.ClientAddr).
	remote   string
	key      []byte
	role     registry.Role
	label    string
	software string
	// Logged in with a client's read-only key: owner is the client's own.
	readOnly bool
	owner    []byte
	send     chan []byte
	// Bytes in send, and the most allowed.
	queued    atomic.Int64
	maxQueued int64
	// Sessions this connection owns; under Server.mu.
	sessions int
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

func (c *conn) writeLoop(ctx context.Context, pingEvery time.Duration) {
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ctx.Done():
			return
		case b := <-c.send:
			wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := c.ws.Write(wctx, websocket.MessageBinary, b)
			cancel()
			c.queued.Add(-int64(len(b)))
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

// queueBytes sends an encoded frame, which callers may share between
// connections: it is never modified.
func (c *conn) queueBytes(b []byte) {
	if c.queued.Add(int64(len(b))) > c.maxQueued {
		c.close(websocket.StatusTryAgainLater, "too slow")
		return
	}
	select {
	case <-c.done:
	case c.send <- b:
	default:
		c.close(websocket.StatusTryAgainLater, "too slow")
	}
}

func errorFrame(code pb.ErrorCode, msg string) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_Error{Error: &pb.Error{Code: code, Message: msg}}}
}

func (e *frameError) frame() *pb.Frame {
	f := errorFrame(e.code, e.msg)
	f.GetError().RequestId = e.requestID
	return f
}

// fail reports err to the peer and closes the connection. Only for the
// connection's own goroutine, outside the server's lock: the write waits.
func (c *conn) fail(ctx context.Context, code pb.ErrorCode, msg string) error {
	if b, err := proto.Marshal(errorFrame(code, msg)); err == nil {
		wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		c.ws.Write(wctx, websocket.MessageBinary, b)
		cancel()
	}
	c.close(websocket.StatusPolicyViolation, msg)
	return errors.New(msg)
}

func (s *Server) readFrame(ctx context.Context, c *conn) (*pb.Frame, error) {
	typ, b, err := c.ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, c.fail(ctx, pb.ErrorCode_ERROR_CODE_INVALID, "text frame")
	}
	f := &pb.Frame{}
	if err := proto.Unmarshal(b, f); err != nil {
		return nil, c.fail(ctx, pb.ErrorCode_ERROR_CODE_INVALID, "undecodable frame")
	}
	return f, nil
}

// writeNow sends f through the connection's queue; used during login,
// before anything else can be queued.
func (s *Server) writeNow(ctx context.Context, c *conn, f *pb.Frame) error {
	c.queue(f)
	select {
	case <-c.done:
		return errors.New("connection closed")
	default:
		return nil
	}
}

func (s *Server) readLoop(ctx context.Context, c *conn) {
	for {
		f, err := s.readFrame(ctx, c)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusMessageTooBig {
				s.log.Info("frame too large", "label", c.label)
			}
			return
		}
		if err := s.handle(c, f); err != nil {
			c.queue(err.frame())
		}
	}
}
