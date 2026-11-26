//go:build hosted

// serve-hosted runs the relay's hosted mode (docs/e2e.md; docs/design.md,
// step 14): many accounts, v1alpha2 only.
// Built only with the hosted tag, so that until stage 6 no release has it:
//
//	go build -tags hosted ./cmd/pirc-relay
//	pirc-relay serve-hosted --origin wss://relay.example (--tls-cert F --tls-key F | --plaintext) [--push-gateway URL] [--test-attestation | stores' flags]
//	pirc-relay backup-hosted [--data-dir DIR] OUT
//	pirc-relay signups-hosted [--data-dir DIR] [open|invite|closed]
//	pirc-relay invite-hosted [--data-dir DIR] [--review] [--uses N] [--days D] [--note TEXT]
//	pirc-relay invites-hosted [--data-dir DIR] [--revoke ID]
//
// Its accounts are in hosted.db in the data directory, which a self-hosted
// relay's registry may share: the two are apart. Besides serve's network
// flags it reads PIRC_RELAY_ORIGIN, PIRC_RELAY_PUSH_GATEWAY and PIRC_RELAY_TEST_ATTESTATION, and
// for the stores' real checks (hosted.Stores) PIRC_RELAY_APPLE_APP_ID,
// PIRC_RELAY_APPLE_IAP_KEY_ID, PIRC_RELAY_APPLE_ISSUER_ID,
// PIRC_RELAY_APPLE_IAP_KEY, PIRC_RELAY_GOOGLE_CREDENTIALS and
// PIRC_RELAY_STORE_SANDBOX; the two key flags name files.

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"time"

	"pirc.dev/relay/internal/hosted"
	"pirc.dev/relay/internal/server"
)

func init() {
	extraCommands["serve-hosted"] = serveHosted
	extraCommands["backup-hosted"] = backupHosted
	extraCommands["signups-hosted"] = signUpsHosted
	extraCommands["invite-hosted"] = inviteHosted
	extraCommands["invites-hosted"] = invitesHosted
}

// openHosted opens the data directory's hosted.db for an admin command,
// beside the running relay; it refuses a directory without one.
func openHosted(dataDir string) (*hosted.Store, error) {
	if _, err := os.Stat(dataDir + "/hosted.db"); err != nil {
		return nil, fmt.Errorf("no hosted.db in %s: give the relay's --data-dir", dataDir)
	}
	return hosted.OpenStore(dataDir)
}

// signUpsHosted shows the sign-up mode, or sets it: open, invite (an
// invite code needed) or closed. The running relay reads it at each
// sign-up.
//
//	pirc-relay signups-hosted [--data-dir DIR] [open|invite|closed]
func signUpsHosted(args []string) error {
	fs, dataDir := flags("signups-hosted")
	if err := parse(fs, dataDir, args); err != nil {
		return err
	}
	if fs.NArg() > 1 {
		return errors.New("usage: pirc-relay signups-hosted [--data-dir DIR] [open|invite|closed]")
	}
	s, err := openHosted(*dataDir)
	if err != nil {
		return err
	}
	defer s.Close()
	if fs.NArg() == 1 {
		if err := s.SetSignUps(fs.Arg(0)); err != nil {
			return err
		}
	}
	m, err := s.SignUps()
	if err != nil {
		return err
	}
	if m == "" {
		m = "not set: the relay's --signups, else " + hosted.DefaultSignUps
	}
	fmt.Println("sign-ups:", m)
	return nil
}

// inviteHosted makes an invite code and prints it, once: only its hash is
// kept. A review code is for the stores' reviewers: its accounts need no
// subscription and are deleted after hosted.ReviewFor.
//
//	pirc-relay invite-hosted [--data-dir DIR] [--review] [--uses N] [--days D] [--note TEXT]
func inviteHosted(args []string) error {
	fs, dataDir := flags("invite-hosted")
	review := fs.Bool("review", false, "a review code, for the stores' reviewers: its accounts need no subscription")
	uses := fs.Int("uses", 1, "how many accounts it may make")
	days := fs.Int("days", 30, "days until it expires")
	note := fs.String("note", "", "who or what it is for, shown by invites-hosted")
	if err := parse(fs, dataDir, args); err != nil {
		return err
	}
	if fs.NArg() != 0 || *days < 1 {
		return errors.New("usage: pirc-relay invite-hosted [--data-dir DIR] [--review] [--uses N] [--days D] [--note TEXT]")
	}
	s, err := openHosted(*dataDir)
	if err != nil {
		return err
	}
	defer s.Close()
	code := hosted.NewInviteCode()
	now := time.Now()
	if err := s.AddInvite(code, *review, *uses, now.Add(time.Duration(*days)*24*time.Hour), now, *note); err != nil {
		return err
	}
	fmt.Println(code)
	return nil
}

// invitesHosted lists the invite codes kept, by an ID (the start of the
// code's hash), or revokes those whose ID starts with --revoke.
//
//	pirc-relay invites-hosted [--data-dir DIR] [--revoke ID]
func invitesHosted(args []string) error {
	fs, dataDir := flags("invites-hosted")
	revoke := fs.String("revoke", "", "end the codes whose ID starts with this")
	if err := parse(fs, dataDir, args); err != nil {
		return err
	}
	s, err := openHosted(*dataDir)
	if err != nil {
		return err
	}
	defer s.Close()
	if *revoke != "" {
		n, err := s.RevokeInvites(*revoke)
		if err != nil {
			return err
		}
		fmt.Printf("%d revoked\n", n)
		return nil
	}
	is, err := s.Invites()
	if err != nil {
		return err
	}
	for _, i := range is {
		kind := "invite"
		if i.Review {
			kind = "review"
		}
		fmt.Printf("%x  %-6s  %d left  expires %s  %s\n", i.CodeHash[:6], kind, i.UsesLeft, i.Expires.UTC().Format("2006-01-02"), i.Note)
	}
	return nil
}

// backupHosted writes a consistent, checked copy of the data directory's
// hosted.db to OUT while the relay runs (hosted.Backup): the hosted
// mode's only state on disk.
//
//	pirc-relay backup-hosted [--data-dir DIR] OUT
func backupHosted(args []string) error {
	fs, dataDir := flags("backup-hosted")
	if err := parse(fs, dataDir, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: pirc-relay backup-hosted [--data-dir DIR] OUT")
	}
	return hosted.Backup(*dataDir, fs.Arg(0))
}

func serveHosted(args []string) error {
	fs, dataDir := flags("serve-hosted")
	nf, err := addNetFlags(fs, hosted.DefaultMaxFrameBytes)
	if err != nil {
		return err
	}
	origin := fs.String("origin", envString("PIRC_RELAY_ORIGIN", ""), "the relay's origin as devices reach it, such as wss://relay.example, which every login signs (PIRC_RELAY_ORIGIN)")
	testDefault, err := envBool("PIRC_RELAY_TEST_ATTESTATION")
	if err != nil {
		return err
	}
	testAtt := fs.Bool("test-attestation", testDefault, "take test attestations and count every subscription live, so that anyone can sign up: for local runs only (PIRC_RELAY_TEST_ATTESTATION)")
	appleApp := fs.String("apple-app-id", envString("PIRC_RELAY_APPLE_APP_ID", ""), "TEAMID.bundle-id: take App Attest and App Store subscriptions of this app (PIRC_RELAY_APPLE_APP_ID)")
	appleKeyID := fs.String("apple-iap-key-id", envString("PIRC_RELAY_APPLE_IAP_KEY_ID", ""), "the App Store Server API's In-App Purchase key ID (PIRC_RELAY_APPLE_IAP_KEY_ID)")
	appleIssuer := fs.String("apple-issuer-id", envString("PIRC_RELAY_APPLE_ISSUER_ID", ""), "the App Store Connect issuer ID (PIRC_RELAY_APPLE_ISSUER_ID)")
	appleKey := fs.String("apple-iap-key", envString("PIRC_RELAY_APPLE_IAP_KEY", ""), "a file with the In-App Purchase key, PKCS #8 PEM (PIRC_RELAY_APPLE_IAP_KEY)")
	android := fs.String("android-package", envString("PIRC_RELAY_ANDROID_PACKAGE", ""), "take Play Integrity and Google Play subscriptions of this package (PIRC_RELAY_ANDROID_PACKAGE)")
	google := fs.String("google-credentials", envString("PIRC_RELAY_GOOGLE_CREDENTIALS", ""), "a file with a Google service account's JSON key, for Play Integrity and the Play Developer API (PIRC_RELAY_GOOGLE_CREDENTIALS)")
	product := fs.String("product", envString("PIRC_RELAY_PRODUCT", "dev.pirc.app.yearly"), "the subscription's product ID on both stores (PIRC_RELAY_PRODUCT)")
	sandboxDefault, err := envBool("PIRC_RELAY_STORE_SANDBOX")
	if err != nil {
		return err
	}
	gatewayFlag := fs.String("push-gateway", envString("PIRC_RELAY_PUSH_GATEWAY", ""), "push gateway to wake the account's phones through when a computer announces a session with push; none when empty (PIRC_RELAY_PUSH_GATEWAY)")
	recheck := fs.Duration("recheck-every", 10*time.Minute, "how often to look for subscriptions due to be asked about again")
	shared := fs.String("shared-addresses", envString("PIRC_RELAY_SHARED_ADDRESSES", ""), "comma-separated IPv4 addresses many people's devices share (the app stores' reviewers' demo computers): their per-address caps are 8 times the others' (PIRC_RELAY_SHARED_ADDRESSES)")
	signUps := fs.String("signups", envString("PIRC_RELAY_SIGNUPS", ""), "sign-ups while the store has none set (signups-hosted): open, invite or closed; open with --test-attestation, else invite, when empty (PIRC_RELAY_SIGNUPS)")
	sandbox := fs.Bool("store-sandbox", sandboxDefault, "take App Attest's development environment and the stores' sandbox and test purchases: for a relay of test builds (PIRC_RELAY_STORE_SANDBOX)")
	if err := parse(fs, dataDir, args); err != nil {
		return err
	}
	sharedAddrs, err := parseSharedAddrs(*shared)
	if err != nil {
		return err
	}
	switch *signUps {
	case "", hosted.SignUpsOpen, hosted.SignUpsInvite, hosted.SignUpsClosed:
	default:
		return fmt.Errorf("--signups is open, invite or closed, not %q", *signUps)
	}
	stores := *appleApp != "" || *android != ""
	if stores && *testAtt {
		return errors.New("--test-attestation and the stores' checks are either or")
	}
	useTLS, proxies, err := nf.check()
	if err != nil {
		return err
	}
	if err := checkOrigin(*origin); err != nil {
		return err
	}
	gateway, err := server.ParseGateway(*gatewayFlag)
	if err != nil {
		return err
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	warnProxies(log, proxies)
	if gateway == "" {
		log.Info("no push gateway: phones registered for push are not woken (--push-gateway)")
	}
	var verifier hosted.Verifier
	switch {
	case *testAtt:
		verifier = hosted.TestVerifier{}
		log.Warn("test attestations taken: anyone can sign up (--test-attestation)")
	case stores:
		cfg := hosted.StoresConfig{AppleAppID: *appleApp, AppleKeyID: *appleKeyID, AppleIssuerID: *appleIssuer, AndroidPackage: *android, Product: *product, Sandbox: *sandbox}
		if *appleApp != "" {
			_, bundle, ok := strings.Cut(*appleApp, ".")
			if !ok || bundle == "" {
				return fmt.Errorf("--apple-app-id %q: TEAMID.bundle-id is needed", *appleApp)
			}
			cfg.AppleBundleID = bundle
		}
		for _, f := range []struct {
			path string
			into *[]byte
		}{{*appleKey, &cfg.AppleKey}, {*google, &cfg.GoogleCredentials}} {
			if f.path == "" {
				continue
			}
			b, err := os.ReadFile(f.path)
			if err != nil {
				return err
			}
			*f.into = b
		}
		v, err := hosted.NewStores(cfg)
		if err != nil {
			return err
		}
		verifier = v
		log.Info("the stores' checks", "apple_app", *appleApp, "app_store_api", len(cfg.AppleKey) > 0, "android_package", *android, "google", len(cfg.GoogleCredentials) > 0, "sandbox", *sandbox)
		if *sandbox {
			log.Warn("sandbox purchases and App Attest's development environment taken (--store-sandbox)")
		}
	default:
		log.Info("no attestation verifier: sign-ups refused")
	}
	store, err := hosted.OpenStore(*dataDir)
	if err != nil {
		return err
	}
	defer store.Close()
	srv, err := hosted.New(hosted.Config{
		Store:          store,
		Origin:         *origin,
		Verifier:       verifier,
		SignUps:        defaultSignUps(*signUps, *testAtt),
		SharedAddrs:    sharedAddrs,
		MaxFrameBytes:  *nf.maxFrame,
		PushGateway:    gateway,
		TrustedProxies: proxies,
		Logger:         log,
	})
	if err != nil {
		return err
	}
	if r, ok := verifier.(hosted.Rechecker); ok {
		ctx, stop := context.WithCancel(context.Background())
		defer stop()
		go srv.RecheckSubscriptions(ctx, r, *recheck)
	}
	return run(log, nf, useTLS, srv.Handler(), srv.Shutdown, hosted.Path, "origin", *origin, "data_dir", *dataDir, "version", version)
}

// checkOrigin requires a ws(s) origin: a scheme and a host, nothing more.
func checkOrigin(s string) error {
	if s == "" {
		return errors.New("--origin is needed: the relay's origin as devices reach it, such as wss://relay.example")
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "wss" && u.Scheme != "ws") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || s[len(s)-1] == '/' {
		return fmt.Errorf("--origin %q: a ws:// or wss:// origin is needed, with no path", s)
	}
	return nil
}

// defaultSignUps is the --signups flag, or open on a relay that takes
// test attestations, which anyone can sign up to anyway.
func defaultSignUps(flag string, test bool) string {
	if flag == "" && test {
		return hosted.SignUpsOpen
	}
	return flag
}

// parseSharedAddrs reads --shared-addresses: IPv4 addresses, as the
// relay's caps key them.
func parseSharedAddrs(s string) ([]string, error) {
	var out []string
	for _, f := range strings.Split(s, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		a, err := netip.ParseAddr(f)
		if err != nil || !a.Is4() {
			return nil, fmt.Errorf("--shared-addresses takes IPv4 addresses, not %q", f)
		}
		out = append(out, a.String())
	}
	return out, nil
}
