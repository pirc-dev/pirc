package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"sync"
	"time"

	"pirc.dev/relay/internal/proxy"
)

// Sender sends an empty push to a target: nil when the push service took
// it, errGone when the token is no longer valid.
type Sender interface {
	Send(ctx context.Context, t Target) error
}

type Config struct {
	Sealer *Sealer
	// Nil for a platform the gateway does not send to. APNs is for
	// production tokens and APNsSandbox for development ones: Apple's
	// keys limited to an app's topic serve one environment each.
	APNs, APNsSandbox, FCM Sender
	// The apps it serves, by bundle ID or package name.
	Apps []string
	// Proxies whose X-Forwarded-For is believed.
	TrustedProxies []netip.Prefix
	// Registrations a minute from one address, and wakes a minute for one
	// token. Wakes are not limited by address: a relay sends every phone's
	// from one.
	RegistersPerMinute, WakesPerMinute int
	Logger                             *slog.Logger
	Now                                func() time.Time
}

type Gateway struct {
	cfg       Config
	apps      map[string]bool
	registers *limiter
	wakes     *limiter

	mu sync.Mutex
	// Counters since the last Counters call: registrations by platform and
	// app version, and wakes by outcome.
	counts map[string]int
}

func New(cfg Config) (*Gateway, error) {
	if cfg.Sealer == nil {
		return nil, errors.New("no gateway key")
	}
	if len(cfg.Apps) == 0 {
		return nil, errors.New("no apps to serve")
	}
	if cfg.RegistersPerMinute == 0 {
		cfg.RegistersPerMinute = 10
	}
	if cfg.WakesPerMinute == 0 {
		cfg.WakesPerMinute = 6
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	g := &Gateway{cfg: cfg, apps: map[string]bool{}, counts: map[string]int{}}
	for _, a := range cfg.Apps {
		g.apps[a] = true
	}
	g.registers = newLimiter(cfg.RegistersPerMinute, cfg.Now)
	g.wakes = newLimiter(cfg.WakesPerMinute, cfg.Now)
	return g, nil
}

func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "OK")
	})
	mux.HandleFunc("POST /v1/register", g.register)
	mux.HandleFunc("POST /v1/wake", g.wake)
	return mux
}

// Counters returns what was counted since the last call, and starts again.
func (g *Gateway) Counters() map[string]int {
	g.mu.Lock()
	defer g.mu.Unlock()
	c := g.counts
	g.counts = map[string]int{}
	return c
}

func (g *Gateway) count(what string) {
	g.mu.Lock()
	g.counts[what]++
	g.mu.Unlock()
}

// The largest request body: a token, a few names.
const maxBody = 4 << 10

var (
	apnsToken = regexp.MustCompile(`^[0-9a-fA-F]{64,200}$`)
	fcmToken  = regexp.MustCompile(`^[A-Za-z0-9_:\-.]{1,512}$`)
	version   = regexp.MustCompile(`^[0-9A-Za-z.+\-]{0,32}$`)
)

func answer(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func refuse(w http.ResponseWriter, status int, msg string) {
	answer(w, status, map[string]string{"error": msg})
}

// notYet answers for a platform the gateway has no credentials for: 503,
// which a relay does not take as the handle gone, so that a gateway started
// without them (or before they exist) drops no registration.
func notYet(w http.ResponseWriter, platform string) {
	w.Header().Set("Retry-After", "3600")
	refuse(w, http.StatusServiceUnavailable, "this gateway does not send to "+platform+" yet")
}

func limited(w http.ResponseWriter, wait time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
	refuse(w, http.StatusTooManyRequests, "too many requests")
}

func decode(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(v)
}

// register gives an app the handle for its push token.
func (g *Gateway) register(w http.ResponseWriter, r *http.Request) {
	addr, _ := proxy.ClientAddr(r, g.cfg.TrustedProxies)
	if ok, wait := g.registers.take(addr); !ok {
		g.count("register limited")
		limited(w, wait)
		return
	}
	var req struct {
		Platform, Token, Environment, App, Version string
	}
	if err := decode(r, &req); err != nil {
		refuse(w, http.StatusBadRequest, "a JSON body is needed")
		return
	}
	t := Target{Platform: req.Platform, Environment: req.Environment, App: req.App, Token: req.Token}
	if msg := g.check(t); msg != "" {
		refuse(w, http.StatusBadRequest, msg)
		return
	}
	if !version.MatchString(req.Version) {
		refuse(w, http.StatusBadRequest, "version not valid")
		return
	}
	if g.sender(t) == nil {
		g.count("register not served " + req.Platform)
		notYet(w, req.Platform)
		return
	}
	h, err := g.cfg.Sealer.Seal(t)
	if err != nil {
		refuse(w, http.StatusBadRequest, err.Error())
		return
	}
	g.count("register " + req.Platform + " " + req.Version)
	answer(w, http.StatusOK, map[string]string{"handle": h})
}

// sender is the target's platform's and environment's, nil when the
// gateway has no credentials for it.
func (g *Gateway) sender(t Target) Sender {
	switch t.Platform {
	case APNs:
		if t.Environment == Development {
			return g.cfg.APNsSandbox
		}
		return g.cfg.APNs
	case FCM:
		return g.cfg.FCM
	}
	return nil
}

// check says what is wrong with a target to register, if anything; a
// platform the gateway has no credentials for is not wrong (notYet).
func (g *Gateway) check(t Target) string {
	if !g.apps[t.App] {
		return "this gateway does not serve that app"
	}
	switch t.Platform {
	case APNs:
		if !apnsToken.MatchString(t.Token) {
			return "an APNs token is 64 to 200 hex characters"
		}
		if t.Environment != Development && t.Environment != Production {
			return "environment is development or production"
		}
	case FCM:
		if !fcmToken.MatchString(t.Token) {
			return "an FCM token is needed"
		}
		if t.Environment != "" {
			return "environment is for APNs only"
		}
	default:
		return "platform is apns or fcm"
	}
	return ""
}

// wakeTimeout bounds a push service's answer.
const wakeTimeout = 15 * time.Second

// wake sends the empty push a relay asks for.
func (g *Gateway) wake(w http.ResponseWriter, r *http.Request) {
	var req struct{ Handle string }
	if err := decode(r, &req); err != nil {
		refuse(w, http.StatusBadRequest, "a JSON body is needed")
		return
	}
	// One this key did not make: made with an earlier key, or forged.
	t, err := g.cfg.Sealer.Open(req.Handle)
	if err != nil {
		g.count("wake unknown handle")
		refuse(w, http.StatusGone, "handle not valid: the app registers again")
		return
	}
	if ok, wait := g.wakes.take(t.Platform + " " + t.Token); !ok {
		g.count("wake limited")
		limited(w, wait)
		return
	}
	if g.check(t) != "" {
		g.count("wake not served")
		refuse(w, http.StatusGone, "this gateway no longer serves that handle")
		return
	}
	send := g.sender(t)
	if send == nil {
		g.count("wake not served " + t.Platform)
		notYet(w, t.Platform)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), wakeTimeout)
	defer cancel()
	switch err := send.Send(ctx, t); {
	case errors.Is(err, errGone):
		g.count("wake gone " + t.Platform)
		refuse(w, http.StatusGone, "the push service no longer knows the token: the app registers again")
	case err != nil:
		g.count("wake failed " + t.Platform)
		g.cfg.Logger.Warn("push failed", "platform", t.Platform, "err", err)
		refuse(w, http.StatusBadGateway, "the push service refused the push")
	default:
		g.count("wake sent " + t.Platform)
		answer(w, http.StatusOK, map[string]string{})
	}
}

// limiter counts by key in fixed one-minute windows, forgetting every key
// when a window ends.
type limiter struct {
	max   int
	now   func() time.Time
	mu    sync.Mutex
	start time.Time
	n     map[string]int
}

func newLimiter(max int, now func() time.Time) *limiter {
	return &limiter{max: max, now: now, start: now(), n: map[string]int{}}
}

// take counts one for key, or says how long until it may.
func (l *limiter) take(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.start) >= time.Minute {
		l.start, l.n = now, map[string]int{}
	}
	if l.n[key] >= l.max {
		return false, l.start.Add(time.Minute).Sub(now)
	}
	l.n[key]++
	return true, 0
}
