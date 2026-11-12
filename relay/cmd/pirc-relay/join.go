package main

import (
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"rsc.io/qr"

	"pirc.dev/relay/internal/registry"
)

// checkRelayURL refuses a relay URL a new device could not connect by:
// ws:// or wss://, with a host, and nothing else that would be ignored.
func checkRelayURL(s string) error {
	u, err := url.Parse(s)
	switch {
	case err != nil:
		return fmt.Errorf("relay URL: %v", err)
	case u.Scheme != "ws" && u.Scheme != "wss":
		return fmt.Errorf("the relay URL must start with ws:// or wss://, not %q", s)
	case u.Hostname() == "":
		return fmt.Errorf("the relay URL has no host: %q", s)
	case u.User != nil || u.RawQuery != "" || u.Fragment != "":
		return fmt.Errorf("the relay URL takes a scheme, host, port and path only: %q", s)
	}
	return nil
}

// joinLink is the link an app joins by, as the web app's joinLink
// (web/page/src/Invite.tsx) and the app's (app/lib/ui/invite.dart) build
// it and app/lib/join.dart reads it.
func joinLink(relay, token string) string {
	return "pirc://join?relay=" + encodeComponent(relay) + "&token=" + encodeComponent(token)
}

// encodeComponent escapes s as JavaScript's encodeURIComponent and Dart's
// Uri.encodeComponent do: everything but letters, digits and -_.!~*'().
// url.QueryEscape differs (a space as +, and it escapes !*'()).
func encodeComponent(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// printJoin prints how a new device joins with token: on out the line to
// use (the link, or the /pirc enrol line), on info what is for the eye
// only (the QR code and when the token expires).
func printJoin(out, info io.Writer, role registry.Role, relay, token string, expires, now time.Time) error {
	until := expires.Format("15:04 MST")
	if y, m, d := expires.Date(); y != now.Year() || m != now.Month() || d != now.Day() {
		until = expires.Format("2006-01-02 15:04 MST")
	}
	if role == registry.RoleHost {
		fmt.Fprintf(out, "/pirc enrol %s %s\n", relay, token)
		fmt.Fprintf(info, "Run it in pi on that computer; valid until %s.\n", until)
		return nil
	}
	link := joinLink(relay, token)
	fmt.Fprintln(out, link)
	// M recovers from 15% damage; the link is short enough for any level,
	// and a higher one only makes the code denser.
	code, err := qr.Encode(link, qr.M)
	if err != nil {
		return err
	}
	io.WriteString(info, drawQR(code))
	fmt.Fprintf(info, "Scan it with PiRC's app, or paste the link into it; valid until %s.\n", until)
	return nil
}

// The colours drawQR draws with, from the 256-colour palette's fixed cube
// (16 is #000000, 231 #ffffff): the first 16, which a terminal's theme
// redefines, could be anything, and Apple's Terminal has no 24-bit colour.
const (
	qrColours = "\x1b[38;5;16;48;5;231m"
	qrReset   = "\x1b[0m"
	quietZone = 4 // modules, as the standard asks
)

// drawQR draws code for a terminal, two rows of modules to a line in
// Unicode half blocks, dark on light whatever the terminal's own colours,
// so that a phone's camera reads it on a dark terminal too, with the
// standard's quiet zone of light modules around it.
func drawQR(code *qr.Code) string {
	dark := func(x, y int) bool { return code.Black(x-quietZone, y-quietZone) }
	n := code.Size + 2*quietZone
	var b strings.Builder
	for y := 0; y < n; y += 2 {
		b.WriteString(qrColours)
		for x := 0; x < n; x++ {
			switch top, bottom := dark(x, y), dark(x, y+1); {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteString(" ")
			}
		}
		b.WriteString(qrReset + "\n")
	}
	return b.String()
}
