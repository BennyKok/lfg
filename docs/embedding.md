# Embedding the OMG application

Every release publishes four packages to npm under the `@omg-dev` scope:

| Package | What it is |
| --- | --- |
| `@omg-dev/protocol` | Shared wire types |
| `@omg-dev/client` | Authenticated HTTP and multiplexed live transport |
| `@omg-dev/react` | Smaller headless / session surfaces |
| `@omg-dev/app` | The exact full OMG application used by the standalone web UI |

```bash
npm install @omg-dev/app @omg-dev/client
```

The four are versioned in lockstep off the release tag and depend on each other
by exact version, so a release installs as one consistent set — `@omg-dev/client`
never resolves against a `@omg-dev/protocol` it did not ship with. Each tag's
tarballs stay attached to its GitHub release too, as the record of what shipped.

React hosts mount the full application with their own transport and asset
origin. OMG keeps its internal navigation in a memory router, so it does not
take over the host product's URL:

```tsx
import { createGrantTransport } from "@omg-dev/client";
import { OmgAppSurface } from "@omg-dev/app";
import "@omg-dev/app/styles.css";

<OmgAppSurface
  transport={createGrantTransport({
    baseUrl: "https://sessions.example",
    getGrant: mintSignedSessionGrant,
  })}
  assetBaseUrl="https://sessions.example"
/>
```

Standalone OMG and embedded hosts therefore render one visual component tree;
only authentication, API origin, and outer product navigation belong to the
host.

## Related

- [embed-host-protocol.md](./embed-host-protocol.md) — the iframe embed contract
  (`?embed=1`), for hosts that frame OMG rather than importing it.
