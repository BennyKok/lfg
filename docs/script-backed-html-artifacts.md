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

Successful runs increment the existing artifact version and emit the repo's
normal realtime artifact update, so an open client refreshes the same card.
Failures leave both the prior HTML and version intact.
