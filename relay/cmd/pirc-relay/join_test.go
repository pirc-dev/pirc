package main

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
	"time"

	"rsc.io/qr"

	"pirc.dev/relay/internal/registry"
)

func TestJoinLink(t *testing.T) {
	// As encodeURIComponent and Uri.encodeComponent give them.
	for _, c := range []struct{ relay, token, want string }{
		{"wss://relay.example", "nSJMEJNmt3KtAbaQHA2z4Q", "pirc://join?relay=wss%3A%2F%2Frelay.example&token=nSJMEJNmt3KtAbaQHA2z4Q"},
		{"wss://relay.example:8443/v1alpha1", "a-b_c", "pirc://join?relay=wss%3A%2F%2Frelay.example%3A8443%2Fv1alpha1&token=a-b_c"},
		{"ws://[fd00::1]:80/a b", "x+y/z=", "pirc://join?relay=ws%3A%2F%2F%5Bfd00%3A%3A1%5D%3A80%2Fa%20b&token=x%2By%2Fz%3D"},
		{"wss://café.example/!~*'()", "t", "pirc://join?relay=wss%3A%2F%2Fcaf%C3%A9.example%2F!~*'()&token=t"},
	} {
		if got := joinLink(c.relay, c.token); got != c.want {
			t.Errorf("joinLink(%q, %q)\n got %s\nwant %s", c.relay, c.token, got, c.want)
		}
	}
}

func TestCheckRelayURL(t *testing.T) {
	for _, s := range []string{"wss://relay.example", "ws://10.0.0.5:8443", "wss://relay.example:443/v1alpha1", "ws://[fd00::1]:8443"} {
		if err := checkRelayURL(s); err != nil {
			t.Errorf("%q: %v", s, err)
		}
	}
	for _, s := range []string{"https://relay.example", "relay.example", "relay.example:8443", "wss://", "wss://:8443", "wss://u:p@relay.example", "wss://relay.example/?a=b", "wss://relay.example/#x", "wss://%zz"} {
		if err := checkRelayURL(s); err == nil {
			t.Errorf("%q: accepted", s)
		}
	}
}

// Without a URL the output is the token alone on stdout, which scripts and
// the tests of other parts read; it must not change.
func TestAddPrintsBareToken(t *testing.T) {
	t.Setenv("PIRC_RELAY_URL", "")
	for _, role := range []registry.Role{registry.RoleClient, registry.RoleHost} {
		var out, info bytes.Buffer
		if err := add(role, []string{"--data-dir", relayDir(t), "--label", "phone"}, &out, &info); err != nil {
			t.Fatal(err)
		}
		if !regexp.MustCompile(`^[A-Za-z0-9_-]{22}\n$`).MatchString(out.String()) {
			t.Errorf("%s: stdout %q", role, out.String())
		}
	}
}

func TestAddRefusesBadURL(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIRC_RELAY_URL", "")
	var out, info bytes.Buffer
	if err := add(registry.RoleClient, []string{"--data-dir", dir, "--url", "https://relay.example"}, &out, &info); err == nil {
		t.Error("https:// accepted")
	}
	t.Setenv("PIRC_RELAY_URL", "relay.example")
	if err := add(registry.RoleHost, []string{"--data-dir", dir}, &out, &info); err == nil {
		t.Error("PIRC_RELAY_URL without a scheme accepted")
	}
	if out.Len() != 0 {
		t.Errorf("stdout %q", out.String())
	}
	if d, err := registry.New(dir).Load(); err != nil || len(d.Tokens) != 0 {
		t.Errorf("tokens issued: %v, %v", d.Tokens, err)
	}
}

func TestAddWithURL(t *testing.T) {
	// The flag wins over the variable.
	t.Setenv("PIRC_RELAY_URL", "wss://other.example")
	var out, info bytes.Buffer
	if err := add(registry.RoleClient, []string{"--data-dir", relayDir(t), "--url", "wss://relay.example"}, &out, &info); err != nil {
		t.Fatal(err)
	}
	link := regexp.MustCompile(`^pirc://join\?relay=wss%3A%2F%2Frelay\.example&token=[A-Za-z0-9_-]{22}\n$`)
	if !link.MatchString(out.String()) {
		t.Fatalf("stdout %q", out.String())
	}
	if got := decodeDrawn(t, info.String()); got+"\n" != out.String() {
		t.Errorf("the code reads %q", got)
	}
	if !regexp.MustCompile(`\nScan it with PiRC's app, or paste the link into it; valid until \d\d:\d\d \S+\.\n$`).MatchString(info.String()) {
		t.Errorf("stderr ends %q", info.String()[max(0, info.Len()-100):])
	}

	out.Reset()
	info.Reset()
	if err := add(registry.RoleHost, []string{"--data-dir", relayDir(t)}, &out, &info); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^/pirc enrol wss://other\.example [A-Za-z0-9_-]{22}\n$`).MatchString(out.String()) {
		t.Errorf("stdout %q", out.String())
	}
	if !regexp.MustCompile(`^Run it in pi on that computer; valid until \d\d:\d\d \S+\.\n$`).MatchString(info.String()) {
		t.Errorf("stderr %q", info.String())
	}
}

func TestExpiryShown(t *testing.T) {
	// With its time zone, since a server's may not be the reader's.
	now := time.Date(2026, 11, 7, 13, 50, 0, 0, time.FixedZone("CET", 3600))
	for ttl, want := range map[time.Duration]string{
		15 * time.Minute: "valid until 14:05 CET.",
		24 * time.Hour:   "valid until 2026-11-08 13:50 CET.",
	} {
		var out, info bytes.Buffer
		if err := printJoin(&out, &info, registry.RoleHost, "wss://relay.example", "t", now.Add(ttl), now); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(info.String(), want) {
			t.Errorf("%s: %q", ttl, info.String())
		}
	}
}

// The code drawn reads back as the link, for links of several versions
// (one block, several, and with version information from 7 on).
func TestQRRoundTrip(t *testing.T) {
	for _, relay := range []string{
		"wss://relay.example",
		"wss://relay.example.org:8443/v1alpha1",
		"wss://a-rather-long-host-name.relay.some-company.example.com:8443/v1alpha1",
		"wss://" + strings.Repeat("x", 60) + ".example.com:8443/v1alpha1",
	} {
		link := joinLink(relay, "nSJMEJNmt3KtAbaQHA2z4Q")
		code, err := qr.Encode(link, qr.M)
		if err != nil {
			t.Fatal(err)
		}
		if got := decodeDrawn(t, drawQR(code)); got != link {
			t.Errorf("version %d: read %q, want %q", (code.Size-17)/4, got, link)
		}
	}
}

// decodeDrawn reads the QR code drawQR drew in text back into modules,
// checks its quiet zone, and decodes it. It is a decoder for what qr.Encode
// makes, written from the standard's layout and not from the encoder's
// code: byte mode, versions 1 to 9, and no errors to correct.
func decodeDrawn(t *testing.T, text string) string {
	t.Helper()
	var rows [][]bool
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, qrColours) {
			continue
		}
		line = strings.TrimSuffix(strings.TrimPrefix(line, qrColours), qrReset)
		var top, bottom []bool
		for _, r := range line {
			top = append(top, r == '█' || r == '▀')
			bottom = append(bottom, r == '█' || r == '▄')
		}
		rows = append(rows, top, bottom)
	}
	n := len(rows[0])
	if len(rows) != n+1 || n%2 != 1 {
		t.Fatalf("%d rows of %d modules", len(rows), n)
	}
	for y, row := range rows {
		for x, dark := range row {
			inside := quietZone <= x && x < n-quietZone && quietZone <= y && y < n-quietZone
			if dark && !inside {
				t.Fatalf("a dark module in the quiet zone at %d,%d", x, y)
			}
		}
	}
	size := n - 2*quietZone
	m := make([][]bool, size)
	for y := range m {
		m[y] = rows[y+quietZone][quietZone : n-quietZone]
	}
	return decodeQR(t, m)
}

func decodeQR(t *testing.T, m [][]bool) string {
	t.Helper()
	size := len(m)
	version := (size - 17) / 4
	if version < 1 || version > 9 || size != 17+4*version {
		t.Fatalf("size %d", size)
	}
	// Which modules carry no data: finders with their separators and the
	// format information, timing, alignment, version information.
	fn := make([][]bool, size)
	for y := range fn {
		fn[y] = make([]bool, size)
	}
	fill := func(x0, y0, w, h int) {
		for y := y0; y < y0+h; y++ {
			for x := x0; x < x0+w; x++ {
				fn[y][x] = true
			}
		}
	}
	fill(0, 0, 9, 9)
	fill(size-8, 0, 8, 9)
	fill(0, size-8, 9, 8)
	fill(6, 0, 1, size)
	fill(0, 6, size, 1)
	if version >= 2 {
		pos := []int{6, size - 7} // versions up to 6 have one between
		if version >= 7 {
			pos = []int{6, (6 + size - 7) / 2, size - 7}
			fill(size-11, 0, 3, 6)
			fill(0, size-11, 6, 3)
		}
		last := pos[len(pos)-1]
		for _, cy := range pos {
			for _, cx := range pos {
				// None where a finder is.
				if !(cx == 6 && cy == 6 || cx == 6 && cy == last || cx == last && cy == 6) {
					fill(cx-2, cy-2, 5, 5)
				}
			}
		}
	}

	// The format information's first copy, around the top-left finder.
	var format int
	for i := 0; i < 15; i++ {
		var x, y int
		switch {
		case i < 6:
			x, y = 8, i
		case i < 8:
			x, y = 8, i+1
		case i == 8:
			x, y = 7, 8
		default:
			x, y = 14-i, 8
		}
		if m[y][x] {
			format |= 1 << i
		}
	}
	mask := -1
	for want := 0; want < 8; want++ {
		data := 0<<3 | want // level M is 00
		rem := data
		for i := 0; i < 10; i++ {
			rem = rem<<1 ^ (rem>>9)*0x537
		}
		if (data<<10|rem)^0x5412 == format {
			mask = want
		}
	}
	if mask < 0 {
		t.Fatalf("format information %015b is not level M", format)
	}
	masked := []func(x, y int) bool{
		func(x, y int) bool { return (x+y)%2 == 0 },
		func(x, y int) bool { return y%2 == 0 },
		func(x, y int) bool { return x%3 == 0 },
		func(x, y int) bool { return (x+y)%3 == 0 },
		func(x, y int) bool { return (x/3+y/2)%2 == 0 },
		func(x, y int) bool { return x*y%2+x*y%3 == 0 },
		func(x, y int) bool { return (x*y%2+x*y%3)%2 == 0 },
		func(x, y int) bool { return ((x+y)%2+x*y%3)%2 == 0 },
	}[mask]

	// The codewords, in the zigzag of column pairs from the bottom right.
	var bits []bool
	for right := size - 1; right >= 1; right -= 2 {
		if right == 6 {
			right = 5
		}
		for v := 0; v < size; v++ {
			for j := 0; j < 2; j++ {
				x, y := right-j, v
				if (right+1)&2 == 0 {
					y = size - 1 - v
				}
				if !fn[y][x] {
					bits = append(bits, m[y][x] != masked(x, y))
				}
			}
		}
	}
	codewords := make([]byte, len(bits)/8)
	for i := range codewords {
		for _, b := range bits[i*8 : i*8+8] {
			codewords[i] <<= 1
			if b {
				codewords[i] |= 1
			}
		}
	}

	// Level M's blocks and error correction codewords per block.
	blocks := []int{1, 1, 1, 2, 2, 4, 4, 4, 5}[version-1]
	ecc := []int{10, 16, 26, 18, 24, 16, 18, 22, 22}[version-1]
	total := []int{26, 44, 70, 100, 134, 172, 196, 242, 292}[version-1]
	if len(codewords) != total {
		t.Fatalf("version %d: %d codewords, want %d", version, len(codewords), total)
	}
	// Interleaved: the first codeword of each block, then the second; the
	// first blocks may be a codeword shorter than the rest.
	short := total/blocks - ecc
	shorter := blocks - total%blocks
	perBlock := make([][]byte, blocks)
	k := 0
	for i := 0; i <= short; i++ {
		for b := range perBlock {
			if i < short || b >= shorter {
				perBlock[b] = append(perBlock[b], codewords[k])
				k++
			}
		}
	}
	data := bytes.Join(perBlock, nil)

	// Byte mode, an 8-bit count, then the bytes.
	if data[0]>>4 != 0b0100 {
		t.Fatalf("mode %04b, not byte mode", data[0]>>4)
	}
	count := int(data[0]&0xf)<<4 | int(data[1]>>4)
	out := make([]byte, count)
	for i := range out {
		out[i] = data[1+i]<<4 | data[2+i]>>4
	}
	return string(out)
}
