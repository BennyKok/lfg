// E2E test helper: build a REAL fleet dashboard from live prod data and
// publish it as an updatable html artifact into a session.
// Usage: bun scripts/prod-fleet-dashboard.ts <sessionId>
const BASE = "http://127.0.0.1:8766";
const sid = process.argv[2];
if (!sid) throw new Error("usage: bun scripts/prod-fleet-dashboard.ts <sessionId>");

const sessionsRes = (await (await fetch(`${BASE}/api/sessions`)).json()) as {
  sessions?: Array<{ agent?: string; busy?: boolean; project?: string }>;
} & Array<{ agent?: string; busy?: boolean; project?: string }>;
const sessions = Array.isArray(sessionsRes) ? sessionsRes : (sessionsRes.sessions ?? []);
const findingsRes = (await (await fetch(`${BASE}/api/auto/findings?status=open`)).json()) as {
  findings?: unknown[];
};
const openFindings = findingsRes.findings?.length ?? 0;

const total = sessions.length;
const busy = sessions.filter((s) => s.busy).length;
const byAgent = new Map<string, number>();
for (const s of sessions) {
  const kind = (s.agent ?? "claude").replace("-aisdk", "");
  byAgent.set(kind, (byAgent.get(kind) ?? 0) + 1);
}
const agents = [...byAgent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
const byProject = new Map<string, number>();
for (const s of sessions) byProject.set(s.project ?? "?", (byProject.get(s.project ?? "?") ?? 0) + 1);
const projects = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

const SLOTS_LIGHT = ["#2a78d6", "#1baf7a", "#eda100", "#4a3aa7", "#e34948"];
const SLOTS_DARK = ["#3987e5", "#199e70", "#c98500", "#9085e9", "#e66767"];
const maxA = Math.max(1, ...agents.map(([, n]) => n));
const maxP = Math.max(1, ...projects.map(([, n]) => n));

const bars = (rows: Array<[string, number]>, max: number, palette: "a" | "p") =>
  rows
    .map(([label, n], i) => {
      const w = Math.round((n / max) * 420);
      const cls = palette === "a" ? `s${i}` : "sp";
      return `<g transform="translate(0,${i * 28})">
        <text x="92" y="14" class="blabel" text-anchor="end">${label}</text>
        <rect x="100" y="3" width="${Math.max(w, 3)}" height="15" rx="4" class="${cls}"/>
        <text x="${100 + Math.max(w, 3) + 8}" y="14" class="bval">${n}</text>
      </g>`;
    })
    .join("");

const updated = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--border:rgba(11,11,11,.10);--good:#006300;
    ${SLOTS_LIGHT.map((c, i) => `--s${i}:${c};`).join("")} --sp:#2a78d6;}
  @media (prefers-color-scheme:dark){:root{--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--border:rgba(255,255,255,.10);--good:#0ca30c;
    ${SLOTS_DARK.map((c, i) => `--s${i}:${c};`).join("")} --sp:#3987e5;}}
  *{box-sizing:border-box;margin:0}
  body{background:var(--surface);color:var(--ink);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
  header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}
  h1{font-size:15px;font-weight:600}
  .updated{font-size:11px;color:var(--muted)}
  .tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
  .tile{border:1px solid var(--border);border-radius:10px;padding:10px 12px}
  .tile .k{font-size:11px;color:var(--ink2)}
  .tile .v{font-size:22px;font-weight:600;margin-top:2px}
  .tile .d{font-size:11px;color:var(--good);margin-top:1px}
  h2{font-size:12px;font-weight:600;color:var(--ink2);margin:12px 0 6px}
  svg{display:block;width:100%;height:auto}
  ${SLOTS_LIGHT.map((_, i) => `.s${i}{fill:var(--s${i})}`).join("")}
  .sp{fill:var(--sp)}
  .blabel{fill:var(--ink2);font-size:11px}
  .bval{fill:var(--ink);font-size:11px;font-weight:600}
</style></head>
<body>
<header><h1>LFG fleet — live</h1><span class="updated">Updated ${updated} · real /api data</span></header>
<div class="tiles">
  <div class="tile"><div class="k">Sessions</div><div class="v">${total}</div><div class="d">&nbsp;</div></div>
  <div class="tile"><div class="k">Busy right now</div><div class="v">${busy}</div><div class="d">${total ? Math.round((busy / total) * 100) : 0}% of fleet</div></div>
  <div class="tile"><div class="k">Open findings</div><div class="v">${openFindings}</div><div class="d">&nbsp;</div></div>
</div>
<h2>Sessions by agent</h2>
<svg viewBox="0 0 640 ${agents.length * 28 + 4}" aria-label="Sessions by agent">${bars(agents, maxA, "a")}</svg>
<h2>Sessions by project</h2>
<svg viewBox="0 0 640 ${projects.length * 28 + 4}" aria-label="Sessions by project">${bars(projects, maxP, "p")}</svg>
</body></html>`;

const res = await fetch(`${BASE}/api/sessions/${sid}/artifacts/html`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: "lfg-fleet-live",
    title: "LFG fleet — live",
    caption: "Real fleet metrics from /api/sessions — re-publish to refresh",
    html,
  }),
});
const out = (await res.json()) as { ok?: boolean; artifact?: { version?: number }; error?: string };
console.log(JSON.stringify({ ok: out.ok, version: out.artifact?.version, error: out.error, total, busy, openFindings }));
