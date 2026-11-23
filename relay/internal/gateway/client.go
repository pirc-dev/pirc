package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
)

// Wake asks the gateway at base (an http(s) URL with no trailing slash) to
// send the empty push for handle, and returns the gateway's status. Both
// relays wake phones through it; the caller decides what a status means.
func Wake(ctx context.Context, hc *http.Client, base, handle, userAgent string) (int, error) {
	body, _ := json.Marshal(map[string]string{"handle": handle})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/wake", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, nil
}
