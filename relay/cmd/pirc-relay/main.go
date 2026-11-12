// pirc-relay runs the PiRC relay and manages its key registry.
//
//	pirc-relay serve       [--listen ADDR] (--tls-cert F --tls-key F | --plaintext)
//	pirc-relay add-host    [--label NAME] [--ttl 15m] [--url URL]   prints a registration token
//	pirc-relay add-client  [--label NAME] [--ttl 15m] [--url URL] [--reusable]   the same, for an app
//	pirc-relay list
//	pirc-relay tokens                               live tokens: their labels, kinds, uses and expiry
//	pirc-relay revoke LABEL                         deletes the live tokens with that label
//	pirc-relay remove KEY-PREFIX
//	pirc-relay label  KEY-PREFIX NAME                 renames a registered key
//	pirc-relay pending                              hosts awaiting approval
//	pirc-relay approve KEY-PREFIX [--label NAME]
//	pirc-relay reject  KEY-PREFIX
//	pirc-relay version
//
// add-host and add-client print the token alone on stdout, which scripts
// read, and how long it is valid on stderr. Given the relay's URL as the
// new device reaches it (--url, or PIRC_RELAY_URL), they print instead
// how to join with it: on stdout the /pirc enrol line to run in the host's
// pi, or the app's pirc://join link; on stderr the link's QR code, to scan
// with the app, and when the token expires.
//
// A host can be enrolled either way: with a token from add-host, or by
// connecting without one and being approved (docs/design.md, 5.3). Approve
// only a key you have compared with the one the host shows (/pirc status
// in its pi): the label is whatever the host claims.
//
// Every command takes --data-dir (or PIRC_RELAY_DATA_DIR), where the
// registry lives; the default is $XDG_STATE_HOME/pirc-relay, else
// ~/.local/state/pirc-relay. A command refuses a data directory owned by
// another user, since files it creates there would lock that user out.
// serve makes the registry when it starts, and the other commands refuse a
// directory without one, which is not the relay's.
//
// serve's flags can also be set in the environment, for a service's
// environment file: PIRC_RELAY_LISTEN, PIRC_RELAY_TLS_CERT,
// PIRC_RELAY_TLS_KEY, PIRC_RELAY_PLAINTEXT (true or false),
// PIRC_RELAY_MAX_FRAME_BYTES, PIRC_RELAY_TRUSTED_PROXIES and
// PIRC_RELAY_CLOSED_TO_HOSTS (true or false). A flag wins
// over its variable.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"text/tabwriter"
	"time"
	"unicode"

	"pirc.dev/relay/internal/proxy"
	"pirc.dev/relay/internal/registry"
	"pirc.dev/relay/internal/server"
)

// Set at release time with -ldflags "-X main.version=..."; see sh/release.sh.
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "serve":
		err = serve(args)
	case "add-host":
		err = add(registry.RoleHost, args, os.Stdout, os.Stderr)
	case "add-client":
		err = add(registry.RoleClient, args, os.Stdout, os.Stderr)
	case "list":
		err = list(args)
	case "tokens":
		err = tokens(args)
	case "revoke":
		err = revoke(args)
	case "remove":
		err = remove(args)
	case "label":
		err = label(args)
	case "pending":
		err = pending(args)
	case "approve":
		err = approve(args)
	case "reject":
		err = reject(args)
	case "version":
		fmt.Println(version)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "pirc-relay:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: pirc-relay serve|add-host|add-client|list|tokens|revoke|remove|label|pending|approve|reject|version [flags]")
	fmt.Fprintln(os.Stderr, "  add-host|add-client print the token on stdout; with --url, how to join with it instead (the QR code and expiry on stderr)")
	os.Exit(2)
}

func defaultDataDir() string {
	if d := os.Getenv("PIRC_RELAY_DATA_DIR"); d != "" {
		return d
	}
	if d := os.Getenv("XDG_STATE_HOME"); d != "" {
		return filepath.Join(d, "pirc-relay")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "pirc-relay")
}

func flags(name string) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	dataDir := fs.String("data-dir", defaultDataDir(), "directory holding registry.json")
	return fs, dataDir
}

// parse parses a command's flags, then checks who owns the data directory.
func parse(fs *flag.FlagSet, dataDir *string, args []string) error {
	fs.Parse(args)
	return checkOwner(*dataDir)
}

// parseAdmin is parse for the commands that read or change the registry,
// which refuse a directory without one, since the relay makes its registry
// when it starts: run without the relay's directory, they would show an
// empty registry, or start one the relay never reads.
func parseAdmin(fs *flag.FlagSet, dataDir *string, args []string) error {
	if err := parse(fs, dataDir, args); err != nil {
		return err
	}
	reg := registry.New(*dataDir)
	ok, err := reg.Exists()
	if err != nil || ok {
		return err
	}
	return fmt.Errorf("no registry at %s: give the relay's own data directory, with --data-dir or PIRC_RELAY_DATA_DIR, running this as the relay's user (sudo -u USER pirc-relay %s --data-dir DIR); the relay makes its registry when it starts", reg.Path, fs.Name())
}

// when is a time as the commands show it: in this machine's time zone,
// named, since the registry's times are UTC and a server's zone may be too.
func when(t time.Time) string {
	return t.Local().Format("2006-01-02 15:04:05 MST")
}

// An empty variable counts as unset, as an environment file's NAME= reads.
func envString(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envBool(name string) (bool, error) {
	switch v := os.Getenv(name); v {
	case "", "false":
		return false, nil
	case "true":
		return true, nil
	default:
		return false, fmt.Errorf("%s must be true or false, not %q", name, v)
	}
}

func envInt(name string, def int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s must be a number, not %q", name, v)
	}
	return n, nil
}

func serve(args []string) error {
	fs, dataDir := flags("serve")
	plainDefault, err := envBool("PIRC_RELAY_PLAINTEXT")
	if err != nil {
		return err
	}
	frameDefault, err := envInt("PIRC_RELAY_MAX_FRAME_BYTES", 16<<20)
	if err != nil {
		return err
	}
	listen := fs.String("listen", envString("PIRC_RELAY_LISTEN", "127.0.0.1:8443"), "address to listen on (PIRC_RELAY_LISTEN)")
	cert := fs.String("tls-cert", envString("PIRC_RELAY_TLS_CERT", ""), "TLS certificate file (PIRC_RELAY_TLS_CERT)")
	key := fs.String("tls-key", envString("PIRC_RELAY_TLS_KEY", ""), "TLS key file (PIRC_RELAY_TLS_KEY)")
	plaintext := fs.Bool("plaintext", plainDefault, "serve without TLS: only on a network that already encrypts, or behind a proxy that terminates TLS (PIRC_RELAY_PLAINTEXT)")
	maxFrame := fs.Int("max-frame-bytes", frameDefault, "largest frame accepted or sent (PIRC_RELAY_MAX_FRAME_BYTES)")
	gatewayFlag := fs.String("push-gateway", envString("PIRC_RELAY_PUSH_GATEWAY", ""), "push gateway to wake clients registered for push through, such as phones; none when empty (PIRC_RELAY_PUSH_GATEWAY)")
	closedDefault, err := envBool("PIRC_RELAY_CLOSED_TO_HOSTS")
	if err != nil {
		return err
	}
	closed := fs.Bool("closed-to-hosts", closedDefault, "no new hosts but those added with add-host: none asking for approval, no host tokens for clients (PIRC_RELAY_CLOSED_TO_HOSTS)")
	proxyList := fs.String("trusted-proxies", envString("PIRC_RELAY_TRUSTED_PROXIES", ""), "comma-separated addresses or CIDR prefixes of proxies whose X-Forwarded-For is believed (PIRC_RELAY_TRUSTED_PROXIES)")
	if err := parse(fs, dataDir, args); err != nil {
		return err
	}

	if *listen == "" {
		return errors.New("--listen is empty")
	}
	proxies, err := proxy.Parse(*proxyList)
	if err != nil {
		return err
	}
	gateway, err := server.ParseGateway(*gatewayFlag)
	if err != nil {
		return err
	}
	useTLS := *cert != "" || *key != ""
	switch {
	case useTLS && (*cert == "" || *key == ""):
		return errors.New("--tls-cert and --tls-key go together")
	case useTLS && *plaintext:
		return errors.New("--plaintext contradicts --tls-cert")
	case !useTLS && !*plaintext:
		return errors.New("TLS is required: give --tls-cert and --tls-key, or --plaintext to serve without it")
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	for _, p := range proxy.Wide(proxies) {
		log.Warn("a trusted proxy prefix covers more than one address: any peer inside it can give any address as its own", "prefix", p)
	}
	if gateway == "" {
		log.Info("no push gateway: clients registered for push are not woken (--push-gateway)")
	}
	if err := registry.New(*dataDir).Create(); err != nil {
		return err
	}
	server.Software = "pirc-relay/" + version
	srv, err := server.New(server.Config{
		Registry:       registry.New(*dataDir),
		MaxFrameBytes:  *maxFrame,
		TrustedProxies: proxies,
		PushGateway:    gateway,
		ClosedToHosts:  *closed,
		Logger:         log,
	})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.Run(ctx)

	// IdleTimeout closes keep-alive connections nobody uses; a WebSocket,
	// hijacked, is the relay's own to time out.
	hs := &http.Server{Addr: *listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// WebSockets are hijacked connections, which http.Server.Shutdown
		// leaves alone: close them first, so peers see a close frame.
		srv.Shutdown(sctx)
		hs.Shutdown(sctx)
	}()
	scheme := "wss"
	if !useTLS {
		scheme = "ws"
	}
	// The certificate is loaded and the address taken before the relay says
	// it listens, so that a bad file or a busy port is the last word logged.
	if useTLS {
		pair, err := tls.LoadX509KeyPair(*cert, *key)
		if err != nil {
			return fmt.Errorf("TLS certificate: %w", err)
		}
		hs.TLSConfig = &tls.Config{Certificates: []tls.Certificate{pair}}
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	log.Info("listening", "url", fmt.Sprintf("%s://%s/v1alpha1", scheme, *listen), "data_dir", *dataDir, "version", version, "trusted_proxies", *proxyList)
	if useTLS {
		err = hs.ServeTLS(ln, "", "")
	} else {
		err = hs.Serve(ln)
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func add(role registry.Role, args []string, stdout, stderr io.Writer) error {
	fs, dataDir := flags("add-" + string(role))
	label := fs.String("label", "", "name shown for this "+string(role))
	ttl := fs.Duration("ttl", 15*time.Minute, "how long the token stays valid")
	relayURL := fs.String("url", envString("PIRC_RELAY_URL", ""), "the relay's URL as the new "+string(role)+" reaches it, ws:// or wss://: prints how to join with the token, not the token alone (PIRC_RELAY_URL)")
	var reusable *bool
	if role == registry.RoleClient {
		reusable = fs.Bool("reusable", false, "a token for several apps until it expires or is used --max-uses times, each labelled LABEL-1, LABEL-2 and so on (needs --label): for a store's reviewers, say")
	}
	maxUses := fs.Int("max-uses", 20, "with --reusable, how many apps it may register")
	if err := parseAdmin(fs, dataDir, args); err != nil {
		return err
	}
	many := reusable != nil && *reusable
	if *relayURL != "" {
		if err := checkRelayURL(*relayURL); err != nil {
			return err
		}
	}
	now := time.Now()
	reg := registry.New(*dataDir)
	var token string
	var err error
	if many {
		token, err = reg.IssueReusableToken(*label, *maxUses, *ttl, now)
	} else {
		token, err = reg.IssueToken(role, *label, *ttl, now)
	}
	if err != nil {
		return err
	}
	if *relayURL != "" {
		if err := printJoin(stdout, stderr, role, *relayURL, token, now.Add(*ttl), now); err != nil {
			return err
		}
		if many {
			fmt.Fprintf(stderr, "Reusable by %d apps, each a full client of this relay, labelled %s-1, %s-2 and so on; pirc-relay revoke %s ends it.\n", *maxUses, *label, *label, *label)
		}
		return nil
	}
	// Without a URL, the token alone on stdout: scripts and tests read it
	// so (token="$(pirc-relay add-client 2>/dev/null)"); keep it that way.
	fmt.Fprintln(stdout, token)
	kind := "one-time"
	if many {
		kind = "reusable"
	}
	fmt.Fprintf(stderr, "%s %s registration token, valid for %s\n", kind, role, *ttl)
	return nil
}

func tokens(args []string) error {
	fs, dataDir := flags("tokens")
	if err := parseAdmin(fs, dataDir, args); err != nil {
		return err
	}
	d, err := registry.New(*dataDir).Load()
	if err != nil {
		return err
	}
	now := time.Now()
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ROLE\tLABEL\tKIND\tUSED\tEXPIRES")
	for _, t := range d.Tokens {
		if !now.Before(t.ExpiresAt) {
			continue
		}
		kind, used := "one-time", ""
		if t.Reusable {
			kind, used = "reusable", fmt.Sprintf("%d of %d", t.Used, t.MaxUses)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", t.Role, shown(t.Label), kind, used, when(t.ExpiresAt))
	}
	return w.Flush()
}

func revoke(args []string) error {
	fs, dataDir := flags("revoke")
	if err := parseAdmin(fs, dataDir, args); err != nil {
		return err
	}
	if fs.NArg() != 1 || fs.Arg(0) == "" {
		return errors.New("usage: pirc-relay revoke LABEL")
	}
	n, err := registry.New(*dataDir).RevokeToken(fs.Arg(0), time.Now())
	if err != nil {
		return err
	}
	fmt.Printf("revoked %d token(s) labelled %q; the keys they registered stay (pirc-relay list, then remove)\n", n, fs.Arg(0))
	return nil
}

func list(args []string) error {
	fs, dataDir := flags("list")
	if err := parseAdmin(fs, dataDir, args); err != nil {
		return err
	}
	d, err := registry.New(*dataDir).Load()
	if err != nil {
		return err
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ROLE\tLABEL\tKEY\tADDED\tPUSH\tREAD")
	yes := func(b bool) string {
		if b {
			return "yes"
		}
		return ""
	}
	for _, k := range d.Sorted() {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", k.Role, shown(k.Label), k.PublicKey, when(k.AddedAt), yes(k.PushHandle != ""), yes(k.ReadKey != ""))
	}
	if err := w.Flush(); err != nil {
		return err
	}
	if n := len(d.Pending(time.Now())); n > 0 {
		fmt.Fprintf(os.Stderr, "%d host(s) awaiting approval: pirc-relay pending\n", n)
	}
	return nil
}

func pending(args []string) error {
	fs, dataDir := flags("pending")
	if err := parseAdmin(fs, dataDir, args); err != nil {
		return err
	}
	d, err := registry.New(*dataDir).Load()
	if err != nil {
		return err
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "LABEL\tKEY\tFROM\tSOFTWARE\tFIRST SEEN\tLAST SEEN")
	for _, q := range d.Pending(time.Now()) {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", shown(q.Label), q.PublicKey, shown(q.Remote), shown(q.Software), when(q.FirstSeen), when(q.LastSeen))
	}
	return w.Flush()
}

// keyArg parses a command that takes one KEY-PREFIX and the given flags.
func keyArg(fs *flag.FlagSet, dataDir *string, args []string) (string, error) {
	// The key comes first, flags after it, as the usage shows.
	var key string
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		key, args = args[0], args[1:]
	}
	if err := parseAdmin(fs, dataDir, args); err != nil {
		return "", err
	}
	if key == "" && fs.NArg() == 1 {
		key = fs.Arg(0)
	} else if key == "" || fs.NArg() != 0 {
		return "", fmt.Errorf("usage: pirc-relay %s KEY-PREFIX", fs.Name())
	}
	return key, nil
}

func approve(args []string) error {
	fs, dataDir := flags("approve")
	label := fs.String("label", "", "name shown for this host, instead of the one it asked with")
	key, err := keyArg(fs, dataDir, args)
	if err != nil {
		return err
	}
	k, err := registry.New(*dataDir).Approve(key, *label, time.Now())
	if err != nil {
		return err
	}
	fmt.Printf("approved host %q %s\n", k.Label, k.PublicKey)
	return nil
}

func reject(args []string) error {
	fs, dataDir := flags("reject")
	key, err := keyArg(fs, dataDir, args)
	if err != nil {
		return err
	}
	q, err := registry.New(*dataDir).Reject(key, time.Now())
	if err != nil {
		return err
	}
	fmt.Printf("rejected host %q %s; it asks again if it connects again\n", q.Label, q.PublicKey)
	return nil
}

func remove(args []string) error {
	fs, dataDir := flags("remove")
	if err := parseAdmin(fs, dataDir, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: pirc-relay remove KEY-PREFIX")
	}
	k, err := registry.New(*dataDir).Remove(fs.Arg(0))
	if err != nil {
		return err
	}
	fmt.Printf("removed %s %q %s\n", k.Role, k.Label, k.PublicKey)
	return nil
}

func label(args []string) error {
	fs, dataDir := flags("label")
	if err := parseAdmin(fs, dataDir, args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return errors.New("usage: pirc-relay label KEY-PREFIX NAME")
	}
	k, err := registry.New(*dataDir).Rename(fs.Arg(0), fs.Arg(1))
	if err != nil {
		return err
	}
	fmt.Printf("renamed %s %s to %q\n", k.Role, k.PublicKey, k.Label)
	return nil
}

// shown is s as printed in a table: as it is if it is printable, quoted
// with escapes otherwise. Labels and software come from the hosts, and a
// tab, newline or escape sequence in one could forge or hide a row.
func shown(s string) string {
	for _, r := range s {
		if r == '\t' || !unicode.IsGraphic(r) {
			return strconv.QuoteToGraphic(s)
		}
	}
	return s
}
