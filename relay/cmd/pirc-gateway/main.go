// Command pirc-gateway is PiRC's push gateway (docs/gateway.md): it wakes
// phones for relays, holding the Apple and Google credentials they cannot.
//
//	pirc-gateway genkey > /etc/pirc-gateway/key
//	pirc-gateway serve --key-file /etc/pirc-gateway/key --apns-key-file ... --fcm-credentials-file ...
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"pirc.dev/relay/internal/gateway"
	"pirc.dev/relay/internal/proxy"
)

var version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "genkey":
		err = genkey()
	case "version":
		fmt.Println(version)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "pirc-gateway:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: pirc-gateway serve|genkey|version [flags]")
	os.Exit(2)
}

// genkey prints a new gateway key, base64. Replacing the key invalidates
// every handle: each app registers again.
func genkey() error {
	k := make([]byte, gateway.KeySize)
	if _, err := rand.Read(k); err != nil {
		return err
	}
	fmt.Println(base64.StdEncoding.EncodeToString(k))
	return nil
}

// An empty variable counts as unset, as an environment file's NAME= reads.
func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fs.String("listen", env("PIRC_GATEWAY_LISTEN", "127.0.0.1:8444"), "address to listen on, behind a proxy that terminates TLS (PIRC_GATEWAY_LISTEN)")
	keyFile := fs.String("key-file", env("PIRC_GATEWAY_KEY_FILE", ""), "the gateway key, as genkey prints it (PIRC_GATEWAY_KEY_FILE)")
	apps := fs.String("apps", env("PIRC_GATEWAY_APPS", "dev.pirc.app"), "comma-separated bundle IDs and package names served (PIRC_GATEWAY_APPS)")
	apnsKey := fs.String("apns-key-file", env("PIRC_GATEWAY_APNS_KEY_FILE", ""), "Apple's .p8 push key; no APNs when empty (PIRC_GATEWAY_APNS_KEY_FILE)")
	apnsKeyID := fs.String("apns-key-id", env("PIRC_GATEWAY_APNS_KEY_ID", ""), "the .p8 key's ID (PIRC_GATEWAY_APNS_KEY_ID)")
	apnsSandboxKey := fs.String("apns-sandbox-key-file", env("PIRC_GATEWAY_APNS_SANDBOX_KEY_FILE", ""), "Apple's .p8 push key for development builds' tokens; none when empty (PIRC_GATEWAY_APNS_SANDBOX_KEY_FILE)")
	apnsSandboxKeyID := fs.String("apns-sandbox-key-id", env("PIRC_GATEWAY_APNS_SANDBOX_KEY_ID", ""), "the sandbox .p8 key's ID (PIRC_GATEWAY_APNS_SANDBOX_KEY_ID)")
	apnsTeam := fs.String("apns-team-id", env("PIRC_GATEWAY_APNS_TEAM_ID", ""), "the Apple developer team's ID (PIRC_GATEWAY_APNS_TEAM_ID)")
	fcmFile := fs.String("fcm-credentials-file", env("PIRC_GATEWAY_FCM_CREDENTIALS_FILE", ""), "the Firebase service account's JSON key; no FCM when empty (PIRC_GATEWAY_FCM_CREDENTIALS_FILE)")
	proxyList := fs.String("trusted-proxies", env("PIRC_GATEWAY_TRUSTED_PROXIES", ""), "comma-separated addresses or CIDR prefixes of proxies whose X-Forwarded-For is believed (PIRC_GATEWAY_TRUSTED_PROXIES)")
	fs.Parse(args)

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *keyFile == "" {
		return errors.New("--key-file is needed: make one with pirc-gateway genkey")
	}
	b, err := os.ReadFile(*keyFile)
	if err != nil {
		return err
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
	if err != nil {
		return fmt.Errorf("%s: not base64", *keyFile)
	}
	sealer, err := gateway.NewSealer(key)
	if err != nil {
		return err
	}
	proxies, err := proxy.Parse(*proxyList)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 15 * time.Second}
	cfg := gateway.Config{Sealer: sealer, TrustedProxies: proxies, Logger: log}
	for _, a := range strings.Split(*apps, ",") {
		if a = strings.TrimSpace(a); a != "" {
			cfg.Apps = append(cfg.Apps, a)
		}
	}
	// One key for each of Apple's environments: a key limited to the app's
	// topic serves only one.
	apnsSender := func(file, id, flag string) (gateway.Sender, error) {
		if file == "" {
			return nil, nil
		}
		if id == "" || *apnsTeam == "" {
			return nil, fmt.Errorf("--%s-file needs --%s-id and --apns-team-id", flag, flag)
		}
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		k, err := gateway.ParseP8(b)
		if err != nil {
			return nil, err
		}
		return &gateway.APNsSender{KeyID: id, TeamID: *apnsTeam, Key: k, Client: client}, nil
	}
	if cfg.APNs, err = apnsSender(*apnsKey, *apnsKeyID, "apns-key"); err != nil {
		return err
	}
	if cfg.APNsSandbox, err = apnsSender(*apnsSandboxKey, *apnsSandboxKeyID, "apns-sandbox-key"); err != nil {
		return err
	}
	if *fcmFile != "" {
		b, err := os.ReadFile(*fcmFile)
		if err != nil {
			return err
		}
		f, err := gateway.ParseServiceAccount(b)
		if err != nil {
			return err
		}
		f.Client = client
		cfg.FCM = f
	}
	g, err := gateway.New(cfg)
	if err != nil {
		return err
	}
	if cfg.APNs == nil && cfg.APNsSandbox == nil && cfg.FCM == nil {
		log.Warn("no push service: every wake answers 503 until APNs or FCM credentials are given")
	}
	log.Info("serving", "listen", *listen, "apns", cfg.APNs != nil, "apns_sandbox", cfg.APNsSandbox != nil, "fcm", cfg.FCM != nil, "apps", cfg.Apps, "version", version)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// The counters, hourly: all the gateway keeps.
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if c := g.Counters(); len(c) > 0 {
					log.Info("counts, last hour", "counts", c)
				}
			}
		}
	}()
	hs := &http.Server{Addr: *listen, Handler: g.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		hs.Shutdown(sctx)
	}()
	if err := hs.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
