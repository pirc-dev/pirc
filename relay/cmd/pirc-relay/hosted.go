//go:build hosted

// serve-hosted runs the relay's hosted mode (docs/e2e.md; docs/design.md,
// step 14): many accounts, v1alpha2 only.
// Built only with the hosted tag, so that until stage 6 no release has it:
//
//	go build -tags hosted ./cmd/pirc-relay
//	pirc-relay serve-hosted --origin wss://relay.example (--tls-cert F --tls-key F | --plaintext) [--test-attestation | stores' flags]
//
// Its accounts are in hosted.db in the data directory, which a self-hosted
// relay's registry may share: the two are apart. Besides serve's network
// flags it reads PIRC_RELAY_ORIGIN and PIRC_RELAY_TEST_ATTESTATION, and
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
	"net/url"
	"os"
	"strings"
	"time"

	"pirc.dev/relay/internal/hosted"
)

func init() { extraCommands["serve-hosted"] = serveHosted }

func serveHosted(args []string) error {
	fs, dataDir := flags("serve-hosted")
	nf, err := addNetFlags(fs)
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
	recheck := fs.Duration("recheck-every", 10*time.Minute, "how often to look for subscriptions due to be asked about again")
	sandbox := fs.Bool("store-sandbox", sandboxDefault, "take App Attest's development environment and the stores' sandbox and test purchases: for a relay of test builds (PIRC_RELAY_STORE_SANDBOX)")
	if err := parse(fs, dataDir, args); err != nil {
		return err
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
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	warnProxies(log, proxies)
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
		MaxFrameBytes:  *nf.maxFrame,
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
