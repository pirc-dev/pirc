# cryptography 2.9.0, with the point comparison fixed

This is the Dart package `cryptography` 2.9.0, from pub.dev
(https://github.com/dint-dev/cryptography), Copyright 2019-2020 Gohilla,
under the Apache License 2.0 (`LICENSE`). Everything here is as published,
except two lines and a comment on them.

What was changed: in `lib/src/dart/ed25519_impl.dart`, `Ed25519Point.equals`
compared the points' x coordinates twice and never their y coordinates, so
the pure-Dart Ed25519 verify accepted some signatures that every other
verifier refuses. The two lines now compare y:

    v0.mul(y, other.z);
    v1.mul(z, other.y);

with a comment above them saying so. `equals-y.patch` is the change,
against the package as published. The mobile app uses this copy through
`dependency_overrides` in `app/pubspec.yaml` until upstream takes the fix
(docs/e2e.md, section 2). The package's own `README.md` is upstream's.
