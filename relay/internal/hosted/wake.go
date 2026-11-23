// Waking phones through the push gateway: a computer announces a session
// with push set, and each phone of its account that has a push handle and
// is connected under neither of its keys is sent an empty push, which makes
// it connect and fetch what is new. Nothing of any session goes to the
// gateway: only the handle the phone registered.

package hosted

import (
	"bytes"
	"context"
	"net/http"
	"sync"
	"time"

	"pirc.dev/relay/internal/gateway"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// How long the gateway has to answer, and how many wakes are in flight at
// once.
const (
	wakeTimeout  = 10 * time.Second
	wakeInFlight = 8
)

// waker sends the wakes, at most one per phone per window: one asked for
// within a window is sent when it ends, if the phone is still not
// connected, so that what happened meanwhile is not missed.
type waker struct {
	s        *Server
	client   *http.Client
	inFlight chan struct{}

	mu sync.Mutex
	// By account ID and the phone's signing key: the window running since
	// its last wake, and whether one was asked for during it.
	windows map[string]*wakeWindow
}

type wakeWindow struct {
	timer *time.Timer
	again bool
}

func newWaker(s *Server) *waker {
	return &waker{s: s, client: &http.Client{Timeout: wakeTimeout}, inFlight: make(chan struct{}, wakeInFlight), windows: map[string]*wakeWindow{}}
}

type sleeper struct {
	key    []byte
	handle string
}

// asleepLocked is each phone on a's newest list that has a push handle and
// is connected under neither of its keys. Under s.mu.
func (s *Server) asleepLocked(a *account) []sleeper {
	if a.deleted {
		return nil
	}
	rows, err := s.store.Devices(a.id)
	if err != nil {
		s.log.Error("cannot read devices", "err", err)
		return nil
	}
	awake := map[string]bool{}
	for o := range a.conns {
		if !o.removed && o.device != nil && o.role != pb.DeviceRole_DEVICE_ROLE_HOST {
			awake[string(o.device.GetSigningKey())] = true
		}
	}
	var out []sleeper
	for _, d := range a.list.body.GetDevices() {
		k := d.GetSigningKey()
		if d.GetRole() != RoleClient || awake[string(k)] || rows[string(k)].pushHandle == "" {
			continue
		}
		out = append(out, sleeper{k, rows[string(k)].pushHandle})
	}
	return out
}

func windowKey(a *account, key []byte) string { return string(a.id) + string(key) }

// wakeLocked wakes a's phones that are asleep. Under s.mu.
func (w *waker) wakeLocked(a *account) {
	for _, p := range w.s.asleepLocked(a) {
		w.wake(a, p.key)
	}
}

// wake sends the phone a push now, or when its window ends.
func (w *waker) wake(a *account, key []byte) {
	k := windowKey(a, key)
	w.mu.Lock()
	defer w.mu.Unlock()
	if win := w.windows[k]; win != nil {
		win.again = true
		return
	}
	w.open(a, key)
	go w.send(a, key)
}

// open starts the phone's window. Under w.mu.
func (w *waker) open(a *account, key []byte) {
	win := &wakeWindow{}
	win.timer = time.AfterFunc(w.s.cfg.WakeWindow, func() { w.close(a, key, win) })
	w.windows[windowKey(a, key)] = win
}

// close ends the phone's window, waking it once more if that was asked for
// and it still sleeps, which starts another.
func (w *waker) close(a *account, key []byte, win *wakeWindow) {
	k := windowKey(a, key)
	w.mu.Lock()
	if w.windows[k] != win {
		w.mu.Unlock()
		return
	}
	delete(w.windows, k)
	again := win.again
	w.mu.Unlock()
	if !again {
		return
	}
	w.s.mu.Lock()
	asleep := false
	for _, p := range w.s.asleepLocked(a) {
		asleep = asleep || bytes.Equal(p.key, key)
	}
	w.s.mu.Unlock()
	if !asleep {
		return
	}
	w.mu.Lock()
	if w.windows[k] == nil {
		w.open(a, key)
	}
	w.mu.Unlock()
	w.send(a, key)
}

// send asks the gateway to wake the phone, with the handle stored now. A
// handle the gateway no longer knows is unregistered; the app registers
// again when it is next opened.
func (w *waker) send(a *account, key []byte) {
	w.inFlight <- struct{}{}
	defer func() { <-w.inFlight }()
	s := w.s
	s.mu.Lock()
	handle := ""
	for _, p := range s.asleepLocked(a) {
		if bytes.Equal(p.key, key) {
			handle = p.handle
		}
	}
	s.mu.Unlock()
	if handle == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), wakeTimeout)
	defer cancel()
	status, err := gateway.Wake(ctx, w.client, s.cfg.PushGateway, handle, "pirc-relay-hosted")
	log := s.log.With("account", shortKey(a.id), "key", shortKey(key))
	switch {
	case err != nil:
		log.Warn("cannot wake a phone", "err", err)
	case status == http.StatusNotFound || status == http.StatusGone:
		s.mu.Lock()
		defer s.mu.Unlock()
		// Only if it still holds the handle the gateway refused.
		rows, err := s.store.Devices(a.id)
		if a.deleted || err != nil || rows[string(key)].pushHandle != handle {
			return
		}
		if err := s.store.SetPush(a.id, key, ""); err != nil {
			log.Error("cannot unregister a phone for push", "err", err)
			return
		}
		log.Info("push handle no longer valid, unregistered", "status", status)
		s.pushDevicesLocked(a)
	case status < 200 || status > 299:
		log.Warn("the push gateway refused a wake", "status", status)
	default:
		log.Info("phone woken")
	}
}
