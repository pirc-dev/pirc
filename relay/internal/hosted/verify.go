// What the stores say of a phone (docs/e2e.md, section 6): that a real app
// on a real phone asks, and that its account is paid for. It stops abuse
// only; it never stands in for the list. The real checks are Stores
// (stores.go); tests and local runs use TestVerifier.

package hosted

import (
	"context"
	"errors"
	"time"

	"pirc.dev/relay/internal/e2e"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// AttestContext is what an attestation binds: framed(AttestContext, the
// relay's origin, the login's nonce, the device's public key). App Attest
// takes its SHA-256 as clientDataHash, Play Integrity as its nonce
// (base64url), so that an attestation is for one login of one key.
const AttestContext = "pirc-attest-v1alpha2"

// attestData is what c's attestation must bind.
func (s *Server) attestData(c *conn) []byte {
	return e2e.Framed(AttestContext, []byte(s.cfg.Origin), c.nonce, c.key)
}

// Attested is what the relay keeps of an attestation, so that deleting the
// account can delete it too: its kind and the store's identifier, such as
// an App Attest key ID.
type Attested struct {
	Kind  string
	Ident []byte
}

type Verifier interface {
	// Attest checks a phone's attestation, which must bind data
	// (AttestContext).
	Attest(ctx context.Context, a *pb.Attestation, data []byte) (Attested, error)
	// Subscribed checks that the subscription the attestation carries is
	// live, the store's trial included, and says what it is.
	Subscribed(ctx context.Context, account []byte, a *pb.Attestation) (Subscription, error)
}

// Subscription is what the relay keeps of a live subscription, to check
// it again: the store's name for it (Apple's original transaction ID,
// Google's purchase token), until when it is paid for, and whether it is
// the store's sandbox.
type Subscription struct {
	Kind    string
	Ident   []byte
	Expires time.Time
	// The store's free trial, or its grace period after a failed payment.
	Trial, Grace bool
	Sandbox      bool
	// The store will renew it at its end: what a client shows, so that no
	// one buys a second while this one carries the account on.
	Renews bool
}

// TestVerifier takes the test attestation, any non-empty bytes, and no
// other kind; every subscription is live. For tests and local runs only:
// with it anyone can sign up.
type TestVerifier struct{}

func (TestVerifier) Attest(_ context.Context, a *pb.Attestation, _ []byte) (Attested, error) {
	if len(a.GetTest()) == 0 {
		return Attested{}, errors.New("this relay takes test attestations only")
	}
	return Attested{Kind: "test", Ident: a.GetTest()}, nil
}

func (TestVerifier) Subscribed(context.Context, []byte, *pb.Attestation) (Subscription, error) {
	return Subscription{Kind: "test", Ident: []byte("test"), Renews: true}, nil
}

// attestationKind names an attestation's kind, for the log.
func attestationKind(a *pb.Attestation) string {
	switch a.GetKind().(type) {
	case *pb.Attestation_AppAttest:
		return "app-attest"
	case *pb.Attestation_PlayIntegrity:
		return "play-integrity"
	case *pb.Attestation_Test:
		return "test"
	}
	return "none"
}
