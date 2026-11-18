//go:build hosted

// serve-hosted runs the relay's hosted mode (docs/e2e.md; docs/design.md,
// step 14, stage 2): many end-to-end encrypted accounts, v1alpha2 only.
// Built only with the hosted tag, so that until stage 6 no release has it:
//
//	go build -tags hosted ./cmd/pirc-relay
//	pirc-relay serve-hosted --origin wss://relay.example (--tls-cert F --tls-key F | --plaintext) [--test-attestation]
//
// Its accounts are in hosted.db in the data directory, which a self-hosted
// relay's registry may share: the two are apart. Besides serve's network
// flags it reads PIRC_RELAY_ORIGIN and PIRC_RELAY_TEST_ATTESTATION.

package main

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"

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
	if err := parse(fs, dataDir, args); err != nil {
		return err
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
	if *testAtt {
		verifier = hosted.TestVerifier{}
		log.Warn("test attestations taken: anyone can sign up (--test-attestation)")
	} else {
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
