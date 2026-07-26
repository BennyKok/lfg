# LFG for iOS

Expo SDK 57 React Native client for the existing LFG server.

## Run

```bash
npm ci
npm run typecheck
npx expo start
```

The app infers the LFG API at port `8766` on the Metro host. Override it with
`EXPO_PUBLIC_LFG_URL` or change it at runtime in Settings.

It supports the live session fleet, realtime transcript chat, send/queue/stop,
agent launches, findings, native UIKit tabs, and iOS 26 Liquid Glass.

The LFG API is local and unauthenticated. Reach it over a private network such
as Tailscale; never expose port `8766` directly to the internet.
