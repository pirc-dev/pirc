package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pirc.dev/relay/internal/registry"
)

func TestEnvBool(t *testing.T) {
	for v, want := range map[string]bool{"": false, "false": false, "true": true} {
		t.Setenv("PIRC_TEST_BOOL", v)
		got, err := envBool("PIRC_TEST_BOOL")
		if err != nil || got != want {
			t.Errorf("%q: got %v, %v; want %v", v, got, err, want)
		}
	}
	for _, v := range []string{"1", "yes", "True", "on"} {
		t.Setenv("PIRC_TEST_BOOL", v)
		if _, err := envBool("PIRC_TEST_BOOL"); err == nil {
			t.Errorf("%q: accepted", v)
		}
	}
}

func TestEnvInt(t *testing.T) {
	t.Setenv("PIRC_TEST_INT", "")
	if n, err := envInt("PIRC_TEST_INT", 7); n != 7 || err != nil {
		t.Errorf("unset: %v, %v", n, err)
	}
	t.Setenv("PIRC_TEST_INT", "1048576")
	if n, err := envInt("PIRC_TEST_INT", 7); n != 1<<20 || err != nil {
		t.Errorf("set: %v, %v", n, err)
	}
	t.Setenv("PIRC_TEST_INT", "16M")
	if _, err := envInt("PIRC_TEST_INT", 7); err == nil {
		t.Error("16M accepted")
	}
}

func TestServeRefusesBadEnv(t *testing.T) {
	t.Setenv("PIRC_RELAY_PLAINTEXT", "yes")
	err := serve([]string{"--data-dir", t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "PIRC_RELAY_PLAINTEXT") {
		t.Fatalf("got %v", err)
	}
}

func TestCheckOwner(t *testing.T) {
	dir := t.TempDir()
	if err := checkOwner(dir); err != nil {
		t.Errorf("own directory: %v", err)
	}
	if err := checkOwner(filepath.Join(dir, "missing")); err != nil {
		t.Errorf("missing directory: %v", err)
	}
	// A directory owned by someone else needs root to make; / is root's.
	if os.Geteuid() != 0 {
		if err := checkOwner("/"); err == nil || !strings.Contains(err.Error(), "belongs to user") {
			t.Errorf("root's directory: %v", err)
		}
	}
}

func TestShown(t *testing.T) {
	for in, want := range map[string]string{
		"laptop":              "laptop",
		"café laptop":         "café laptop",
		"desk\tKEY\t10.0.0.5": `"desk\tKEY\t10.0.0.5"`,
		"evil\n\x1b[2Kdesk":   `"evil\n\x1b[2Kdesk"`,
		"zero\u200bwidth":     `"zero\u200bwidth"`,
	} {
		if got := shown(in); got != want {
			t.Errorf("shown(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestAddReusable(t *testing.T) {
	dir := t.TempDir()
	var out, info bytes.Buffer
	if err := add(registry.RoleClient, []string{"--data-dir", dir, "--label", "review-apple", "--ttl", "720h", "--reusable", "--url", "wss://relay.example"}, &out, &info); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "pirc://join?") || !strings.Contains(info.String(), "review-apple-1, review-apple-2") {
		t.Fatalf("out %q, info %q", out.String(), info.String())
	}
	d, err := registry.New(dir).Load()
	if err != nil || len(d.Tokens) != 1 || !d.Tokens[0].Reusable || d.Tokens[0].Label != "review-apple" {
		t.Fatalf("%+v %v", d, err)
	}
	if err := add(registry.RoleClient, []string{"--data-dir", dir, "--reusable"}, &out, &info); !errors.Is(err, registry.ErrLabelEmpty) {
		t.Fatalf("no label: %v", err)
	}
}
