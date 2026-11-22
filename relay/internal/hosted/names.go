// The account's names (docs/e2e.md, section 3): signed by the account's
// phone and sealed to each client's box key, kept in the store since the
// phone may not connect for weeks, and given to each client in Devices.

package hosted

import (
	"bytes"
	"time"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// publishNames replaces the account's names with the copies of the
// account's phone, by its signing key, and sends Devices to every
// watcher once they are stored. Under s.mu.
func (s *Server) publishNames(c *conn, p *pb.PublishNames) *frameError {
	a := c.acct
	if c.role != pb.DeviceRole_DEVICE_ROLE_CLIENT || !bytes.Equal(c.key, a.list.phoneKey) {
		return denied("only the account's phone publishes names")
	}
	copies, e := checkCopies(p.GetCopies(), MinSealedBytes, MaxNamesBytes, a.list.boxKeyListed)
	if e != nil {
		return e
	}
	now := s.cfg.Now()
	if now.Sub(s.lastNamesTrim) >= time.Hour {
		s.lastNamesTrim = now
		for k, n := range s.namesPublishes {
			if now.Sub(n.since) >= time.Hour {
				delete(s.namesPublishes, k)
			}
		}
	}
	if !count(s.namesPublishes, string(a.id), s.cfg.MaxNamesPublishesPerAccount, now) {
		return rateLimited("too many names published; try again in an hour")
	}
	if err := s.store.SetNames(a.id, copies); err != nil {
		s.log.Error("cannot store names", "account", shortKey(a.id), "err", err)
		return internal()
	}
	return nil
}
