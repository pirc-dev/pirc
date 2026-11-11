//go:build !unix

package main

// checkOwner has nothing to check where files have no Unix owner.
func checkOwner(string) error { return nil }
