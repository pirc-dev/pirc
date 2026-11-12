# PiRC's mobile app

Flutter, for iOS and Android (`docs/design.md`, section 12, step 13). Its
protocol types are generated from `proto/` into `lib/gen` (git ignores
them); its client logic, `lib/core`, is a port of `web/core`, module for
module, kept in step by the shared cases in `cases/`
(`test/cases_test.dart`).

    sh/app.sh          generate, analyze and test, as sh/check.sh does

Needs Flutter on `PATH`; `sh/check.sh` skips the app without it.

The screens are checked by golden images (`test/goldens`), drawn from a
model fed real relay frames, with the Roboto in Flutter's cache. They are
drawn on macOS and skipped elsewhere, and in CI, saying so; after a change to a
screen, `flutter test --update-goldens` draws them again, and the images
are looked at before they are kept.

`ios/PircNotices` is the iOS notification extension's core, a Swift
package with no Flutter in it: it reads the session list with the
read-only key and writes the notifications (`docs/design.md`, section 12,
step 13). Its protocol types are generated with swift-protobuf, and git
ignores them too.

    sh/notices.sh      generate and swift test, as sh/check.sh does

It needs Swift on `PATH`, and Go for the tests that start a relay. The
Command Line Tools are enough: the tests use Swift Testing, not XCTest.

## The native halves

The native halves are in the local plugin `packages/pirc_platform`, so
that every engine has them, the one a push starts too: the keys
(`KeyStore.swift`, `KeyStore.kt`, behind `lib/keys/key_store.dart`'s
channel), the prefs, notifications, and the private folder (`Files.swift`,
`Files.kt`, behind `lib/app/files.dart`), which holds the chats kept on
the phone: on iOS `Application Support/private`, with complete protection
and out of backups, both set again on each file written there; on Android
`noBackupFilesDir/private`, and the app allows no backup at all. The
simulator keeps no file protection, so it reads back empty there; a phone
shows it. `ios/Notifications` is the
notification extension target, embedded in the app, around PircNotices.
What the app and the extension share, on iOS:

- the read-only key: a Keychain generic password, service
  `dev.pirc.read-key`, account the relay's URL, access group
  `4PC6T9727Y.dev.pirc.shared`, readable after the first unlock, its
  value the 32-byte seed. The main key is service `dev.pirc.main-key` in
  the app's own group `4PC6T9727Y.dev.pirc.app`, behind Face ID or the
  passcode when the lock is on;
- the App Group `group.dev.pirc.app`, whose defaults hold `relay`, the
  relay's URL, and `notices.v1`, what was last shown (PircNotices'
  `Shown`, as a JSON string).

On Android each seed is in a file in `noBackupFilesDir`, encrypted with
an AES key in the Keystore; the main key's asks for a fingerprint, the
face or the PIN at each use, which needs Android 11 (`minSdk` 30).

To build, Xcode for iOS and Android Studio's SDK for Android; the
extension's Swift types first, since git ignores them:

    sh/notices.sh                          generates them (and tests)
    flutter build ios --simulator --debug
    flutter build apk --debug              JAVA_HOME at Android Studio's jbr

`integration_test` runs the key stores and the prefs on a phone or
simulator: `flutter test integration_test -d <device>`. `flutter test`
uninstalls the app after each run; `prefs_test.dart` says how to check
that the relay outlives a restart. `scan_test.dart` reads a join code
from a picture of it, as the camera would; on Android:

    qrencode -o join-qr.png '<link>'
    flutter build apk --debug -t integration_test/scan_test.dart --dart-define=SCAN_TEXT='<link>'
    adb install -r build/app/outputs/flutter-apk/app-debug.apk
    adb push join-qr.png /data/local/tmp/
    adb shell "cat /data/local/tmp/join-qr.png | run-as dev.pirc.app sh -c 'mkdir -p cache && cat > cache/join-qr.png'"
    adb shell am start -n dev.pirc.app/.MainActivity     then: adb logcat -s flutter

The subscription's iOS half runs against StoreKit's test store
(`ios/RunnerTests/PiRC.storekit`, the product as in App Store Connect) in
`ios/RunnerTests/StoreTests.swift`. The test store does not answer on
Xcode 26.3's iOS 26.3 simulator (an Apple bug), so on an iOS 18.6 one:

    xcodebuild -downloadPlatform iOS -buildVersion 18.6
    xcrun simctl create pirc-ios18 "iPhone 16 Pro" com.apple.CoreSimulator.SimRuntime.iOS-18-6
    cd ios && xcodebuild test -workspace Runner.xcworkspace -scheme Runner \
      -destination 'platform=iOS Simulator,name=pirc-ios18' -only-testing:RunnerTests

## Notifications

`lib/push`: after joining, a page says what notifications are for, then the
system asks. While they are allowed the app gives the phone's push token to
the publisher's gateway (`push.pirc.dev`; `--dart-define=PIRC_GATEWAY=…`
for a stub) for a handle, which it registers with the relay
(`RegisterPush`); while they are not, it undoes the relay's registration.
While open it keeps what is listed as shown (`notices.v1`). On iOS the
notification extension writes the notifications; on Android FCM's wake
starts `wakeMain` (`lib/main.dart`) in an engine of its own
(`packages/pirc_platform`'s `WakeService`), which reads the relay with the
read-only key and posts them. `packages/pirc_platform` is the app's own
platform code (key store, prefs, notifications) as a plugin, so that every
engine has it; `android/app/google-services.json` is the publisher's
Firebase project.

`PIRC_RELAY_PUSH_GATEWAY=https://push.pirc.dev node … app/demo.ts` gives the
demo's relay the gateway, so that an emulator with Google's APIs joined to
it is woken for real when the demo's pi finishes a turn with the app in the
background. The iOS simulator is woken for real the same way, through
Apple's development servers. `xcrun simctl push` is not that: it posts its
payload as a local notification, which no notification extension sees.
To watch the extension, `xcrun lldb --batch -o "process attach --name
Notifications --waitfor"` before the wake.

## A relay to join, for looking at the app

    node --experimental-transform-types --no-warnings app/demo.ts

starts a relay of its own on this machine's loopback, two hosts (each a
pi with the extension and the fake model, as `web/test/demo.ts` has)
with sessions in a few states: Markdown, tool calls, a table, a failed
command, a question waiting and a turn running; the laptop's pi opens a
new agent beside it, with the demo's own arguments; and a third pi,
started without a token, asks to join, for the app to approve or reject
(rejected, it asks again when it next connects). It prints a join link
for an Android emulator (the relay at `10.0.2.2`) and one for the iOS
simulator, and runs until interrupted, removing everything it started.
Nothing reaches any other relay. On an emulator with a PIN set
(`adb shell locksettings set-pin <pin>`), joining asks for it once, to
lock the key; `adb shell input text <pin>` answers.

The link opens the app from outside it too, as the phone's camera would:
`adb shell "am start -a android.intent.action.VIEW -d '<link>'"` on an
emulator, `xcrun simctl openurl booted '<link>'` on the simulator, which
first asks whether to open it in PiRC unless PiRC is in front.

## Store builds

Only the stores' builds have the paywall (`docs/design.md`, step 15,
Price): they are made with `--dart-define=PIRC_STORE=true`, on `flutter
build appbundle` for Google Play and on `flutter build ios --config-only
--release` (or `flutter build ipa`) before archiving for the App Store.
Without it the app has no subscription and opens without the paywall.
An app bundle or an archive made without `PIRC_STORE` stops, so that a
store release cannot forget it; `--dart-define=PIRC_STORE=false` makes
one without the paywall. An archive takes the defines the last `flutter`
command wrote (`ios/Flutter/Generated.xcconfig`), so archive right after
the `--config-only` command that gave `PIRC_STORE=true`.

## Android release

A release (`flutter build appbundle`) is signed with Play's upload key,
given at build time and kept outside the repo: `PIRC_UPLOAD_KEYSTORE`, the
path of a PKCS12 keystore; `PIRC_UPLOAD_KEYSTORE_PASSWORD`, which opens it
and its key; and `PIRC_UPLOAD_KEY_ALIAS` when the alias is not `upload`.
Without them a release build stops, rather than sign with another key
(`android/app/build.gradle.kts`); so do `flutter build apk` and `flutter
run --release`, which are release builds too. Debug and profile builds
are signed with the debug key as usual.

Each release build also writes the notices of the Android libraries it takes,
from their POMs and from the notices Google's closed libraries carry, into
its assets (`pirc/android_notices.json`); Settings, Licences shows them
with Flutter's. A library under a licence the build does not know stops
it: add the licence's text to `android/notices/` and its case to the
`Notices` task. It reads Maven modules only: a jar or AAR added as a file
needs its notice added by hand. To check a bundle on an emulator, `bundletool build-apks`
with the same key, then `bundletool install-apks`.

## Signing for a device

Automatic signing, by Xcode with an App Store Connect API key, from a
keychain kept for these builds alone, so that nothing is read from or
written to the login keychain:

- the keychain, made once, with a random password kept elsewhere:
  `security create-keychain -p <password> pirc-build.keychain-db`, then
  `security set-keychain-settings` (no auto-lock) and adding it to the
  user's search list after the keychains already there
  (`security list-keychains -d user -s <those> <it>`), leaving the
  default keychain as it is;
- the development certificate, made through the API from a key made
  here (`openssl genrsa`, a CSR, `POST /v1/certificates`), not by Xcode,
  which would keep its key in the default keychain; the key, the
  certificate and Apple's WWDR G3 intermediate imported into the
  keychain, with `security set-key-partition-list -S
  apple-tool:,apple:,codesign:` so that codesign needs no prompt;
- each build: unlock the keychain, `flutter build ios --config-only`,
  then in `ios/`:

      xcodebuild -workspace Runner.xcworkspace -scheme Runner \
        -configuration Debug -destination 'generic/platform=iOS' \
        -allowProvisioningUpdates -authenticationKeyPath <key.p8> \
        -authenticationKeyID <id> -authenticationKeyIssuerID <issuer> \
        OTHER_CODE_SIGN_FLAGS="--keychain <keychain>" build

  Xcode makes the development profiles for `dev.pirc.app` and
  `dev.pirc.app.notifications` itself, for the team's registered devices.
