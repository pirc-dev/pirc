//go:build hosted

package main

import "testing"

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
