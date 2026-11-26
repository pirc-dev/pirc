//go:build hosted

package main

import (
	"fmt"
	"testing"
	"time"

	"pirc.dev/relay/internal/hosted"
)

func TestCheckOrigin(t *testing.T) {
	for _, s := range []string{"wss://relay.example", "ws://10.0.0.5:8443", "wss://[fd00::1]:8443"} {
		if err := checkOrigin(s); err != nil {
			t.Errorf("%q: %v", s, err)
		}
	}
	for _, s := range []string{"", "https://relay.example", "relay.example", "wss://relay.example/", "wss://relay.example/v1alpha2", "wss://u@relay.example", "wss://relay.example?a", "wss://"} {
		if err := checkOrigin(s); err == nil {
			t.Errorf("%q: accepted", s)
		}
	}
}

func TestServeHostedRegistered(t *testing.T) {
	if extraCommands["serve-hosted"] == nil {
		t.Error("no serve-hosted")
	}
}

func TestInviteCommands(t *testing.T) {
	dir := t.TempDir()
	if err := signUpsHosted([]string{"--data-dir", dir, "open"}); err == nil {
		t.Fatal("a directory with no hosted.db taken")
	}
	s, err := hosted.OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if err := signUpsHosted([]string{"--data-dir", dir, "open"}); err != nil {
		t.Fatal(err)
	}
	if err := signUpsHosted([]string{"--data-dir", dir, "often"}); err == nil {
		t.Error("an unknown mode taken")
	}
	if err := inviteHosted([]string{"--data-dir", dir, "--review", "--uses", "20", "--days", "90", "--note", "App Review"}); err != nil {
		t.Fatal(err)
	}
	if err := invitesHosted([]string{"--data-dir", dir}); err != nil {
		t.Fatal(err)
	}
	s, _ = hosted.OpenStore(dir)
	defer s.Close()
	if m, _ := s.SignUps(); m != hosted.SignUpsOpen {
		t.Errorf("mode %q", m)
	}
	is, _ := s.Invites()
	if len(is) != 1 || !is[0].Review || is[0].UsesLeft != 20 || is[0].Note != "App Review" || is[0].Expires.Before(time.Now().Add(89*24*time.Hour)) {
		t.Fatalf("invites %+v", is)
	}
	if err := invitesHosted([]string{"--data-dir", dir, "--revoke", fmt.Sprintf("%x", is[0].CodeHash[:3])}); err != nil {
		t.Fatal(err)
	}
	if is, _ := s.Invites(); len(is) != 0 {
		t.Errorf("not revoked: %+v", is)
	}
}

func TestParseSharedAddrs(t *testing.T) {
	if got, err := parseSharedAddrs(" 10.70.5.10, ,10.0.0.1"); err != nil || len(got) != 2 || got[0] != "10.70.5.10" {
		t.Errorf("%v %v", got, err)
	}
	for _, bad := range []string{"10.70.5", "::1", "relay.example"} {
		if _, err := parseSharedAddrs(bad); err == nil {
			t.Errorf("%q taken", bad)
		}
	}
}
