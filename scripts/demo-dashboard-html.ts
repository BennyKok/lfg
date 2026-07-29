// Emits the JSON body for POST /api/sessions/:id/artifacts/html.
// Usage: bun scripts/demo-dashboard-html.ts <tick>
// tick=1 → first publish; tick=2 → the "one minute later" re-publish, so the
// live-update path (same id, bumped version) is visibly exercised.
const tick = Number(process.argv[2] ?? 1);

// 12h of hourly "active sessions" per agent kind. tick 2 appends a fresh hour.
const claude = [2, 3, 3, 4, 3, 5, 4, 6, 5, 7, 6, 8];
const codex = [1, 1, 2, 2, 3, 2, 3, 3, 4, 3, 4, 5];
if (tick >= 2) {
  claude.push(9);
  codex.push(4);
  claude.shift();
  codex.shift();
}
const tokens = tick >= 2 ? [742, 388, 141] : [694, 361, 128]; // k tokens: claude, codex, opencode
const stats = {
  sessions: tick >= 2 ? 13 : 11,
  sessionsDelta: tick >= 2 ? "+2 this hour" : "+1 this hour",
  tokens: tick >= 2 ? "1.27M" : "1.18M",
  tokensDelta: tick >= 2 ? "+92k this hour" : "+64k this hour",
  findings: 2,
};
const updated = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const W = 640, H = 180, PADL = 30, PADR = 74, PADT = 12, PADB = 22;
const yMax = 10;
const xs = (i: number, n: number) => PADL + (i * (W - PADL - PADR)) / (n - 1);
const ys = (v: number) => PADT + (1 - v / yMax) * (H - PADT - PADB);
const pts = (arr: number[]) => arr.map((v, i) => `${xs(i, arr.length).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
const hours = claude.map((_, i) => {
  const d = new Date(Date.now() - (claude.length - 1 - i) * 3600_000);
  return `${d.getHours()}:00`;
});

const grid = [0, 2.5, 5, 7.5, 10]
  .map((v) => `<line x1="${PADL}" x2="${W - PADR}" y1="${ys(v)}" y2="${ys(v)}" class="${v === 0 ? "baseline" : "grid"}"/>` +
    (v > 0 ? `<text x="${PADL - 6}" y="${ys(v) + 3}" class="tick" text-anchor="end">${v}</text>` : ""))
  .join("");
const xticks = hours
  .map((h, i) => (i % 3 === 0 ? `<text x="${xs(i, hours.length)}" y="${H - 6}" class="tick" text-anchor="middle">${h}</text>` : ""))
  .join("");

const barMax = 800;
const bar = (label: string, v: number, cls: string, i: number) => {
  const bw = (v / barMax) * 420;
  return `<g transform="translate(0,${i * 30})">
    <text x="86" y="14" class="blabel" text-anchor="end">${label}</text>
    <rect x="94" y="2" width="${bw.toFixed(0)}" height="16" rx="4" class="${cls}"/>
    <text x="${(94 + bw + 8).toFixed(0)}" y="14" class="bval">${v}k</text>
  </g>`;
};

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root{
    --surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
    --grid:#e1e0d9;--baseline:#c3c2b7;--border:rgba(11,11,11,.10);
    --s1:#2a78d6;--s2:#1baf7a;--s3:#eda100;--good:#006300;
  }
  @media (prefers-color-scheme:dark){:root{
    --surface:#1a1a19;--ink:#ffffff;--ink2:#c3c2b7;--muted:#898781;
    --grid:#2c2c2a;--baseline:#383835;--border:rgba(255,255,255,.10);
    --s1:#3987e5;--s2:#199e70;--s3:#c98500;--good:#0ca30c;
  }}
  *{box-sizing:border-box;margin:0}
  body{background:var(--surface);color:var(--ink);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
  header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}
  h1{font-size:15px;font-weight:600;letter-spacing:-.01em}
  .updated{font-size:11px;color:var(--muted)}
  .tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
  .tile{border:1px solid var(--border);border-radius:10px;padding:10px 12px}
  .tile .k{font-size:11px;color:var(--ink2)}
  .tile .v{font-size:22px;font-weight:600;letter-spacing:-.02em;margin-top:2px}
  .tile .d{font-size:11px;color:var(--good);margin-top:1px}
  section{margin-bottom:14px}
  h2{font-size:12px;font-weight:600;color:var(--ink2);margin-bottom:6px}
  .legend{display:flex;gap:14px;font-size:11px;color:var(--ink2);margin-bottom:4px}
  .legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}
  svg{display:block;width:100%;height:auto}
  .grid{stroke:var(--grid);stroke-width:1}
  .baseline{stroke:var(--baseline);stroke-width:1}
  .tick{fill:var(--muted);font-size:10px}
  .l1{stroke:var(--s1);stroke-width:2;fill:none;stroke-linejoin:round}
  .l2{stroke:var(--s2);stroke-width:2;fill:none;stroke-linejoin:round}
  .dlabel{font-size:11px;font-weight:600}
  .d1{fill:var(--s1)}.d2{fill:var(--s2)}
  .b1{fill:var(--s1)}.b2{fill:var(--s2)}.b3{fill:var(--s3)}
  .blabel{fill:var(--ink2);font-size:11px}
  .bval{fill:var(--ink);font-size:11px;font-weight:600}
  #tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--surface);
    padding:4px 8px;border-radius:6px;font-size:11px;opacity:0;transition:opacity .1s}
  .xline{stroke:var(--baseline);stroke-width:1;opacity:0}
</style></head>
<body>
<header><h1>Fleet dashboard</h1><span class="updated">Updated ${updated} · refreshes every minute</span></header>
<div class="tiles">
  <div class="tile"><div class="k">Active sessions</div><div class="v">${stats.sessions}</div><div class="d">↑ ${stats.sessionsDelta}</div></div>
  <div class="tile"><div class="k">Tokens today</div><div class="v">${stats.tokens}</div><div class="d">↑ ${stats.tokensDelta}</div></div>
  <div class="tile"><div class="k">Open findings</div><div class="v">${stats.findings}</div><div class="d">&nbsp;</div></div>
</div>
<section>
  <h2>Active sessions — last 12 h</h2>
  <div class="legend"><span><i style="background:var(--s1)"></i>claude</span><span><i style="background:var(--s2)"></i>codex</span></div>
  <svg id="line" viewBox="0 0 ${W} ${H}" aria-label="Active sessions by hour, claude and codex">
    ${grid}${xticks}
    <line id="xl" class="xline" y1="${PADT}" y2="${H - PADB}" x1="0" x2="0"/>
    <polyline class="l1" points="${pts(claude)}"/>
    <polyline class="l2" points="${pts(codex)}"/>
    <text class="dlabel d1" x="${W - PADR + 8}" y="${ys(claude[claude.length - 1]) + 4}">claude ${claude[claude.length - 1]}</text>
    <text class="dlabel d2" x="${W - PADR + 8}" y="${ys(codex[codex.length - 1]) + 4}">codex ${codex[codex.length - 1]}</text>
  </svg>
</section>
<section>
  <h2>Tokens by agent — today</h2>
  <svg viewBox="0 0 640 92" aria-label="Tokens by agent">
    ${bar("claude", tokens[0], "b1", 0)}${bar("codex", tokens[1], "b2", 1)}${bar("opencode", tokens[2], "b3", 2)}
  </svg>
</section>
<div id="tip"></div>
<script>
  const claude=${JSON.stringify(claude)},codex=${JSON.stringify(codex)},hours=${JSON.stringify(hours)};
  const svg=document.getElementById('line'),tip=document.getElementById('tip'),xl=document.getElementById('xl');
  const PADL=${PADL},PADR=${PADR},W=${W};
  svg.addEventListener('mousemove',(e)=>{
    const r=svg.getBoundingClientRect();
    const fx=(e.clientX-r.left)/r.width*W;
    const n=claude.length;
    const i=Math.max(0,Math.min(n-1,Math.round((fx-PADL)/((W-PADL-PADR)/(n-1)))));
    const x=PADL+i*(W-PADL-PADR)/(n-1);
    xl.setAttribute('x1',x);xl.setAttribute('x2',x);xl.style.opacity=1;
    tip.style.opacity=1;
    tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY-10)+'px';
    tip.textContent=hours[i]+' — claude '+claude[i]+' · codex '+codex[i];
  });
  svg.addEventListener('mouseleave',()=>{tip.style.opacity=0;xl.style.opacity=0;});
</script>
</body></html>`;

console.log(
  JSON.stringify({
    id: "fleet-dashboard",
    title: "Fleet dashboard",
    caption: "Live fleet metrics — re-published every minute by the agent",
    html,
  }),
);
