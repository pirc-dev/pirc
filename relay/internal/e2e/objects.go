// Signed objects (docs/e2e.md, section 2): a body as its signer encoded
// it, the signer's key, and an Ed25519 signature over framed("pirc-e2e-v1
// <kind>", account ID, body). Verified on those bytes before the body is
// parsed; never encoded again.

package e2e

import (
	"bytes"
	"crypto/sha256"

	"google.golang.org/protobuf/proto"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// Refused is why an object, a version, a withdrawal or a pre-key is not
// accepted: the input's fault, not the relay's.
type Refused struct{ Reason string }

func (r *Refused) Error() string { return r.Reason }

func refuse(reason string) error { return &Refused{reason} }

var errOpen = refuse("the signature does not check, or the body names another signer")

func signedBytes(kind string, accountID, body []byte) []byte {
	return Framed("pirc-e2e-v1 "+kind, accountID, body)
}

// open checks obj's signature, then parses its body into body and
// requires the body's own signer field to be obj's signer.
func open[B proto.Message](kind string, accountID []byte, obj *pb.SignedObject, body B, signer func(B) []byte) (B, error) {
	var zero B
	if !Verify(obj.GetSigner(), signedBytes(kind, accountID, obj.GetBody()), obj.GetSignature()) {
		return zero, errOpen
	}
	if err := proto.Unmarshal(obj.GetBody(), body); err != nil {
		return zero, errOpen
	}
	if !bytes.Equal(signer(body), obj.GetSigner()) {
		return zero, errOpen
	}
	return body, nil
}

// OpenList opens a list version. The account ID is empty for version 1.
func OpenList(accountID []byte, obj *pb.SignedObject) (*pb.ListVersionBody, error) {
	return open("list", accountID, obj, &pb.ListVersionBody{}, (*pb.ListVersionBody).GetSigner)
}

func OpenWithdrawal(accountID []byte, obj *pb.SignedObject) (*pb.WithdrawalBody, error) {
	return open("withdrawal", accountID, obj, &pb.WithdrawalBody{}, (*pb.WithdrawalBody).GetSigner)
}

func OpenPreKey(accountID []byte, obj *pb.SignedObject) (*pb.PreKeyBody, error) {
	return open("pre-key", accountID, obj, &pb.PreKeyBody{}, (*pb.PreKeyBody).GetSigner)
}

// OpenBundle opens a host's bundle, signed by its host_key.
func OpenBundle(accountID []byte, obj *pb.SignedObject) (*pb.BundleBody, error) {
	return open("bundle", accountID, obj, &pb.BundleBody{}, (*pb.BundleBody).GetHostKey)
}

func OpenLabels(accountID []byte, obj *pb.SignedObject) (*pb.LabelsBody, error) {
	return open("labels", accountID, obj, &pb.LabelsBody{}, (*pb.LabelsBody).GetSigner)
}

func OpenLabelKey(accountID []byte, obj *pb.SignedObject) (*pb.LabelKeyWrapBody, error) {
	return open("label-key", accountID, obj, &pb.LabelKeyWrapBody{}, (*pb.LabelKeyWrapBody).GetSigner)
}

// Hash is SHA-256 of the body: a version's hash, and version 1's is the
// account ID.
func Hash(obj *pb.SignedObject) []byte {
	h := sha256.Sum256(obj.GetBody())
	return h[:]
}
