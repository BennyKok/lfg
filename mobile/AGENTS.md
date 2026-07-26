# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## SDK / Expo Go coupling — read before bumping

This project is on **SDK 57**, which requires an Expo Go 57 client.

As of 2026-07-26, Expo Go for SDK 57 was **not on the App Store** — Expo was
still awaiting Apple's approval, so it had to be obtained via `eas go`. If you
open this project in an App Store Expo Go, it fails with "Project is
incompatible with this version of Expo Go" and there is no update to install.
The project was briefly pinned to SDK 56 for exactly this reason.

Expo Go ships only the **latest released** SDK, and its version number now
tracks the SDK (56.0.4, 57.0.5, …). Before bumping the SDK, check that the
matching Expo Go is actually on the App Store:

```bash
curl -s https://api.expo.dev/v2/versions/latest \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s).data.sdkVersions;for(const[k,x]of Object.entries(v))if(+k.split('.')[0]>=54)console.log(k,x.iosClientVersion)})"
```

and cross-check the SDK changelog at https://expo.dev/changelog/ for an
"awaiting approval" note. Alternatively, move off Expo Go to a development
build (`eas build --profile development`), which removes the coupling entirely.
