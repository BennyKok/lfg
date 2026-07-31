# Embedding the LFG application

Every release publishes four immutable packages:

| Package | What it is |
| --- | --- |
| `@lfg-dev/protocol` | Shared wire types |
| `@lfg-dev/client` | Authenticated HTTP and multiplexed live transport |
| `@lfg-dev/react` | Smaller headless / session surfaces |
| `@lfg-dev/app` | The exact full LFG application used by the standalone web UI |

React hosts mount the full application with their own transport and asset
origin. LFG keeps its internal navigation in a memory router, so it does not
take over the host product's URL:

```tsx
import { createGrantTransport } from "@lfg-dev/client";
import { LfgAppSurface } from "@lfg-dev/app";
import "@lfg-dev/app/styles.css";

<LfgAppSurface
  transport={createGrantTransport({
    baseUrl: "https://sessions.example",
    getGrant: mintSignedSessionGrant,
  })}
  assetBaseUrl="https://sessions.example"
/>
```

Standalone LFG and embedded hosts therefore render one visual component tree;
only authentication, API origin, and outer product navigation belong to the
host.

## Related

- [embed-host-protocol.md](./embed-host-protocol.md) — the iframe embed contract
  (`?embed=1`), for hosts that frame LFG rather than importing it.
