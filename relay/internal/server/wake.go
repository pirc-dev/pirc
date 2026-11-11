// Waking clients through the push gateway (docs/design.md, section 12,
// step 13): a host flags an announcement whose notice is new, and every
// client registered for push that is connected under neither of its keys
// is sent an empty push, which makes it connect and read the list.

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"pirc.dev/relay/internal/registry"
)

// Bounds of waking: how long the gateway has to answer, and how many wakes
// are in flight at once.
const (
	wakeTimeout  = 10 * time.Second
	wakeInFlight = 8
)

// ParseGateway checks a push gateway's address: empty, for none, or an
// http(s) URL with no query, to which /v1/wake is added.
func ParseGateway(s string) (string, error) {
	if s == "" {
		return "", nil
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("push gateway %q: an http(s) URL is needed", s)
	}
	return strings.TrimSuffix(s, "/"), nil
}

// waker sends the wakes, at most one per client per window: one asked for
// within a window is sent when it ends, if the client is still not
// connected, so that what happened meanwhile is not missed.
type waker struct {
	s        *Server
	client   *http.Client
	inFlight chan struct{}

	mu sync.Mutex
	// By client key, encoded: the window running since its last wake, and
	// whether one was asked for during it.
	windows map[string]*wakeWindow
}

type wakeWindow struct {
	timer *time.Timer
	again bool
}

func newWaker(s *Server) *waker {
	return &waker{s: s, client: &http.Client{Timeout: wakeTimeout}, inFlight: make(chan struct{}, wakeInFlight), windows: map[string]*wakeWindow{}}
}

// asleepLocked returns the clients registered for push that are connected
// under neither of their keys. Under s.mu.
func (s *Server) asleepLocked() []registry.Key {
	if s.reg == nil {
		return nil
	}
	awake := map[string]bool{}
	for c := range s.conns {
		if c.readOnly {
			awake[registry.EncodeKey(c.owner)] = true
		} else {
			awake[registry.EncodeKey(c.key)] = true
		}
	}
	var out []registry.Key
	for _, k := range s.reg.Keys {
		if k.Role == registry.RoleClient && k.PushHandle != "" && !awake[k.PublicKey] {
			out = append(out, k)
		}
	}
	return out
}

// wakeAll wakes the clients asleep now. Under s.mu.
func (w *waker) wakeAllLocked() {
	for _, k := range w.s.asleepLocked() {
		w.wake(k.PublicKey)
	}
}

// wake sends key's client a push now, or when its window ends.
func (w *waker) wake(key string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if win := w.windows[key]; win != nil {
		win.again = true
		return
	}
	w.open(key)
	go w.send(key)
}

// open starts key's window. Under w.mu.
func (w *waker) open(key string) {
	win := &wakeWindow{}
	win.timer = time.AfterFunc(w.s.cfg.WakeWindow, func() { w.close(key, win) })
	w.windows[key] = win
}

// close ends key's window, waking it once more if that was asked for and
// it still sleeps, which starts another.
func (w *waker) close(key string, win *wakeWindow) {
	w.mu.Lock()
	if w.windows[key] != win {
		w.mu.Unlock()
		return
	}
	delete(w.windows, key)
	again := win.again
	w.mu.Unlock()
	if !again {
		return
	}
	w.s.mu.Lock()
	asleep := false
	for _, k := range w.s.asleepLocked() {
		asleep = asleep || k.PublicKey == key
	}
	w.s.mu.Unlock()
	if !asleep {
		return
	}
	w.mu.Lock()
	if w.windows[key] == nil {
		w.open(key)
	}
	w.mu.Unlock()
	w.send(key)
}

// send asks the gateway to wake the client, with the handle registered
// now. A handle the gateway no longer knows is unregistered; the app
// registers again when it is next opened.
func (w *waker) send(key string) {
	w.inFlight <- struct{}{}
	defer func() { <-w.inFlight }()
	w.s.mu.Lock()
	var k registry.Key
	ok := false
	if w.s.reg != nil {
		for _, x := range w.s.reg.Keys {
			if x.PublicKey == key {
				k, ok = x, true
			}
		}
	}
	w.s.mu.Unlock()
	if !ok || k.PushHandle == "" {
		return
	}
	status, err := w.post(k.PushHandle)
	log := w.s.log.With("label", k.Label)
	switch {
	case err != nil:
		log.Warn("cannot wake a client", "err", err)
	case status == http.StatusNotFound || status == http.StatusGone:
		pub, _ := registry.DecodeKey(key)
		cleared, err := w.s.cfg.Registry.ClearPush(pub, k.PushHandle)
		switch {
		case err != nil && !errors.Is(err, registry.ErrNotFound):
			log.Error("cannot unregister a client for push", "err", err)
		case cleared:
			log.Info("push handle no longer valid, unregistered", "status", status)
			_ = w.s.reloadRegistry(true)
		}
	case status < 200 || status > 299:
		log.Warn("the push gateway refused a wake", "status", status)
	default:
		log.Info("client woken")
	}
}

func (w *waker) post(handle string) (int, error) {
	body, _ := json.Marshal(map[string]string{"handle": handle})
	ctx, cancel := context.WithTimeout(context.Background(), wakeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.s.cfg.PushGateway+"/v1/wake", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", Software)
	resp, err := w.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, nil
}
