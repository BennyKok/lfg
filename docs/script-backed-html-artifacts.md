# Script-backed HTML artifacts

An HTML artifact can keep one stable card while LFG refreshes its contents from
the server. The executable script must live inside the owning session's cwd and
must print one complete, self-contained HTML document to stdout. LFG passes an
explicit argv without a shell, limits each run, prevents overlap, and replaces
the last good document only after a zero exit and valid output.

For example, make the bundled data-query script executable:

```sh
chmod +x examples/artifact-refresh/user-growth.py
```

Then call `lfg_publish_artifact` from the owning session:

```json
{
  "id": "omg-user-growth",
  "title": "OMG user growth",
  "html": "<!doctype html><html><body>Loading first update…</body></html>",
  "refreshScriptPath": "/absolute/repo/examples/artifact-refresh/user-growth.py",
  "refreshArgv": ["--endpoint", "https://stats.example.test/growth"],
  "refreshIntervalSeconds": 300,
  "refreshTimeoutSeconds": 30
}
```

The example reads `GROWTH_API_TOKEN` from the server environment, queries JSON,
and prints inline HTML/CSS. The rendered iframe remains sandboxed without
network access and cannot invoke the host refresh endpoint.

Use `lfg_refresh_artifact` with `{"id":"omg-user-growth","action":"now"}`
for an immediate run, or `action: "status"` to read `status`, `lastStartedAt`,
`lastSuccessAt`, `lastError`, and the artifact `version`. Update only the
schedule by omitting `html` and reusing the same `id`. Set `refreshEnabled` to
`false` to pause automatic runs while retaining manual refresh, or set
`refreshScriptPath` to `null` to remove the refresh configuration.

Successful runs update the document and refresh timestamp without incrementing
the artifact revision. They still emit the normal realtime artifact update, so
an open client reloads the same card. Failures leave the prior HTML, timestamp,
and revision intact.

Stable HTML artifact ids are project-level. If a later session publishes new
HTML with the same id, it takes ownership of the existing artifact, updates the
same card, and continues the revision chain. The refresh configuration transfers
with the artifact and can be rebound to an executable inside the new owner's
cwd; the previous session can no longer refresh, reconfigure, or delete it.

The Artifacts page labels scheduled dashboards with their most recent
successful refresh time. Delete an artifact from that page with its trash
button, or call `lfg_delete_artifact` with its stable `id`. Deletion is limited
to the owning session, cancels any active refresh process, removes the schedule,
and permanently removes the stored artifact.
