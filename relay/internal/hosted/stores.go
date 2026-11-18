// The stores' real checks (docs/design.md, step 14, stage 4): App Attest
// and Play Integrity for attestations, and the App Store Server API and
// the Play Developer API for subscriptions. What each checks is beside it,
// in appattest.go, playintegrity.go, appstore.go and googleplay.go.

package hosted

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// StoresConfig names the app as each store knows it, and the credentials
// the relay asks the stores' servers with. A store left out refuses its
// attestations and subscriptions.
type StoresConfig struct {
	// TEAMID.bundle-id, as App Attest's relying party.
	AppleAppID string
	// The app's bundle ID, which Apple's signed transactions name.
	AppleBundleID string
	// The App Store Server API's In-App Purchase key: its ID, issuer ID and
	// PKCS #8 PEM.
	AppleKeyID, AppleIssuerID string
	AppleKey                  []byte
	// The Android package name.
	AndroidPackage string
	// A Google service account's JSON key, with access to the Play
	// Integrity API of the project linked in Play Console and to the
	// app's financial data there (for the purchases API).
	GoogleCredentials []byte
	// The subscription's product ID, the same on both stores.
	Product string
	// Sandbox lets in App Attest's development environment, and the
	// stores' sandbox and test purchases: every TestFlight purchase, and
	// Play's license testers'. For a relay of test builds, not the public
	// one.
	Sandbox bool
	HTTP    *http.Client
	Now     func() time.Time
}

// Stores is the Verifier of the stores' real checks.
type Stores struct {
	cfg    StoresConfig
	google *googleToken
	apple  *appleSigner
}

func NewStores(cfg StoresConfig) (*Stores, error) {
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 15 * time.Second}
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	s := &Stores{cfg: cfg}
	if len(cfg.GoogleCredentials) > 0 {
		g, err := newGoogleToken(cfg.GoogleCredentials, cfg.HTTP, cfg.Now)
		if err != nil {
			return nil, fmt.Errorf("the Google credentials: %w", err)
		}
		s.google = g
	}
	if len(cfg.AppleKey) > 0 {
		a, err := newAppleSigner(cfg.AppleKeyID, cfg.AppleIssuerID, cfg.AppleBundleID, cfg.AppleKey, cfg.Now)
		if err != nil {
			return nil, fmt.Errorf("the In-App Purchase key: %w", err)
		}
		s.apple = a
	}
	return s, nil
}

func (s *Stores) Attest(ctx context.Context, a *pb.Attestation, data []byte) (Attested, error) {
	switch k := a.GetKind().(type) {
	case *pb.Attestation_AppAttest:
		if s.cfg.AppleAppID == "" {
			return Attested{}, errors.New("this relay takes no App Attest")
		}
		return verifyAppAttest(k.AppAttest, data, s.cfg.AppleAppID, s.cfg.Sandbox, s.cfg.Now())
	case *pb.Attestation_PlayIntegrity:
		if s.google == nil || s.cfg.AndroidPackage == "" {
			return Attested{}, errors.New("this relay takes no Play Integrity")
		}
		return s.verifyPlayIntegrity(ctx, k.PlayIntegrity.GetToken(), data)
	}
	return Attested{}, errors.New("no attestation of a kind this relay takes")
}

func (s *Stores) Subscribed(ctx context.Context, _ []byte, a *pb.Attestation) (Subscription, error) {
	if a.GetSubscription() == "" {
		return Subscription{}, errors.New("no subscription")
	}
	switch a.GetKind().(type) {
	case *pb.Attestation_AppAttest:
		return s.appStoreSubscription(ctx, a.GetSubscription())
	case *pb.Attestation_PlayIntegrity:
		return s.playSubscription(ctx, a.GetSubscription())
	}
	return Subscription{}, errors.New("a subscription from no store this relay knows")
}

// Recheck asks the store again of a subscription the relay keeps, for one
// that may have lapsed or been refunded since.
func (s *Stores) Recheck(ctx context.Context, sub Subscription) (Subscription, error) {
	switch sub.Kind {
	case "app-store":
		return s.appStoreStatus(ctx, string(sub.Ident), sub.Sandbox)
	case "google-play":
		return s.playSubscription(ctx, string(sub.Ident))
	}
	return Subscription{}, fmt.Errorf("a subscription of kind %q", sub.Kind)
}
