# LFG Mobile (Expo prototype)

A React Native + Expo scaffold, currently a todo app used to validate the
native toolchain before porting real LFG surfaces.

- Expo SDK 57, React Native 0.86, React 19, TypeScript
  (needs an Expo Go 57 client — see `AGENTS.md` for the SDK/Expo Go coupling)
- Persistence via `@react-native-async-storage/async-storage`
- Safe-area handling via `react-native-safe-area-context`

## Layout

```
App.tsx            screen shell: header, composer, filters, list
src/useTodos.ts    todo state + AsyncStorage persistence hook
src/TodoRow.tsx    memoized row (toggle + delete)
src/theme.ts       colors / radius / spacing tokens
```

## Run it on your phone (Expo Go)

This repo usually lives on a remote dev box, so the LAN QR code won't reach
your phone. Use a tunnel:

```bash
cd mobile
npx expo start --tunnel
```

Scan the QR with the Camera app (iOS) or from inside Expo Go. The URL looks
like `exp://<slug>-anonymous-8081.exp.direct`.

On the same LAN you can drop `--tunnel` and use `npx expo start` instead.

## Run it in a browser (fast iteration / screenshots)

```bash
npx expo start --web --host localhost --port 8082
```

## Ship to TestFlight from Linux

You never need a Mac. `eas build` compiles on Expo's hosted macOS workers; the
`eas` CLI itself is just Node, so Linux is fine. (`eas build --local` is the
exception — local iOS builds need Xcode/CocoaPods/fastlane, i.e. macOS. Don't
go that route from here.)

One-time setup:

1. **Apple Developer Program** membership — $99/yr. Required for TestFlight;
   there is no free path to distributing on a physical device at scale.
2. `npm i -g eas-cli && eas login` (free Expo account).
3. `eas build:configure` — links the project, writes the EAS project id into
   `app.json`. `eas.json` is already committed here.
4. `eas credentials --platform ios` — sign in with your Apple ID. EAS generates
   and stores the distribution certificate and provisioning profile *remotely*;
   nothing is generated on your machine. Also set up an **App Store Connect API
   key** here — it makes `eas submit` non-interactive and avoids
   app-specific-password juggling.
5. Create the app record in App Store Connect (bundle id `dev.lfg.todo`, see
   `app.json`), then put its numeric Apple ID into `eas.json` →
   `submit.production.ios.ascAppId`.

Each release:

```bash
eas build --platform ios --profile production   # ~15-30 min on hosted macOS
eas submit --platform ios --profile production  # uploads the .ipa
```

The build appears in TestFlight ~10-15 min after submit, once Apple finishes
processing. Internal testers (up to 100, your own devices) need no review;
external testers require Beta App Review.

Cost note: the Expo free tier gives 15 iOS builds with low queue priority and a
45-minute build timeout — fine for this. Paid tiers ($19/mo Starter) buy queue
priority and longer timeouts, not capability.

### Faster iteration than a full build

Prefer a **development build** over Expo Go once this grows native modules:

```bash
eas build --platform ios --profile development
```

Install it once; after that it behaves like Expo Go but with *your* native
code, and it decouples you from Expo Go's App Store release schedule (the exact
problem that forced the SDK 56 pin — see `AGENTS.md`).

For JS-only changes, `expo-updates` can push OTA to an existing TestFlight
build with no new binary and no Apple review.

## Notes

- The Metro dev server binds `0.0.0.0:8081`. On the shared dev box, port 8081
  is firewalled to loopback + `tailscale0`; the tunnel dials out from
  localhost, so it is unaffected.
- Typecheck with `npx tsc --noEmit`.
