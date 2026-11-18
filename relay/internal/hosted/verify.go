// What the stores say of a phone (docs/e2e.md, section 6): that a real app
// on a real phone asks, and that its account is paid for. It stops abuse
// only; it never stands in for the list. The real checks, App Attest, Play
// Integrity and the stores' subscription APIs, are tried in stage 4
// (docs/design.md, step 14); until then a relay runs with the test
// verifier, or takes no sign-ups.

package hosted

import (
	"context"
	"errors"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// Attested is what the relay keeps of an attestation, so that deleting the
// account can delete it too: its kind and the store's identifier, such as
// an App Attest key ID.
type Attested struct {
	Kind  string
	Ident []byte
}

type Verifier interface {
	// Attest checks a phone's attestation for its device key.
	Attest(ctx context.Context, a *pb.Attestation, key []byte) (Attested, error)
	// Subscribed checks that the subscription the attestation carries is
	// live, or that the account is in its trial.
	Subscribed(ctx context.Context, account []byte, a *pb.Attestation) error
}

// TestVerifier takes the test attestation, any non-empty bytes, and no
// other kind; every subscription is live. For tests and local runs only:
// with it anyone can sign up.
type TestVerifier struct{}

func (TestVerifier) Attest(_ context.Context, a *pb.Attestation, key []byte) (Attested, error) {
	if len(a.GetTest()) == 0 {
		return Attested{}, errors.New("this relay takes test attestations only")
	}
	return Attested{Kind: "test", Ident: a.GetTest()}, nil
}

func (TestVerifier) Subscribed(context.Context, []byte, *pb.Attestation) error { return nil }
