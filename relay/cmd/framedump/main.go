// framedump reads length-prefixed protocol messages from stdin (a Frame
// carrying a Routed payload, then a SessionMessage) and prints them as
// JSON. Used by sh/check.sh to compare Go's decoding with TypeScript's.
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha1"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "framedump:", err)
		os.Exit(1)
	}
}

func next(r io.Reader) ([]byte, error) {
	var n uint32
	if err := binary.Read(r, binary.BigEndian, &n); err != nil {
		return nil, err
	}
	b := make([]byte, n)
	_, err := io.ReadFull(r, b)
	return b, err
}

func asJSON(m proto.Message) (json.RawMessage, error) {
	return protojson.Marshal(m)
}

func run() error {
	frameBytes, err := next(os.Stdin)
	if err != nil {
		return err
	}
	eventBytes, err := next(os.Stdin)
	if err != nil {
		return err
	}

	frame := &pb.Frame{}
	if err := proto.Unmarshal(frameBytes, frame); err != nil {
		return fmt.Errorf("frame: %w", err)
	}
	routed := frame.GetRouted()
	if routed == nil {
		return fmt.Errorf("frame is not routed")
	}
	payload := &pb.SessionMessage{}
	if err := proto.Unmarshal(routed.GetPayload(), payload); err != nil {
		return fmt.Errorf("payload: %w", err)
	}
	event := &pb.SessionMessage{}
	if err := proto.Unmarshal(eventBytes, event); err != nil {
		return fmt.Errorf("event: %w", err)
	}

	out := map[string]json.RawMessage{}
	for k, m := range map[string]proto.Message{"frame": frame, "payload": payload, "event": event} {
		if out[k], err = asJSON(m); err != nil {
			return err
		}
	}
	return json.NewEncoder(os.Stdout).Encode(out)
}
