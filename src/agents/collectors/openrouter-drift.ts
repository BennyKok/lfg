import { readFile } from "node:fs/promises";
import type { CollectorResult } from "./index.ts";

// Deterministic price-drift check for the model-watch agent.
//
// WHY THIS EXISTS (and why we don't diff the aggregate /models catalog):
// OpenRouter's top-level `/api/v1/models` pricing for a model is the CHEAPEST
// currently-available endpoint — a floating floor across every provider that
// serves it (glm-5.2 has 20). Our llm.go pins ONE specific endpoint's rate
// (e.g. DeepInfra $1/$4). Diffing pinned-endpoint vs floating-floor flags
// "drift" every time a cheaper fp8 provider shows up, even though the endpoint
// we pin is unchanged. That produced the glm-5.2 "30% overbill" false alarm.
//
// Instead we pull the PER-MODEL endpoints list and build the live [min,max]
// envelope per field. A carried price is only real drift when it falls OUTSIDE
// that envelope — i.e. NO provider on OpenRouter offers it. A price that merely
// sits above the floor (because a cheaper endpoint exists) is provider spread,
// not drift, and is silently OK. This turns a flaky LLM judgement on a flapping
// number into a deterministic boolean the agent just relays.

const ENDPOINTS_URL = (id: string) =>
  `https://openrouter.ai/api/v1/models/${id}/endpoints`;

// microdollars → $/1M tokens. llm.go convention: 1_000_000 micros = $1.00/1M.
const microsToPerM = (micros: number) => micros / 1_000_000;
// OR pricing strings are $/token. → $/1M tokens.
const perTokenToPerM = (s: string | undefined): number | null => {
  const n = Number(s);
  return isFinite(n) && n > 0 ? n * 1_000_000 : null;
};

type Carried = {
  id: string;
  inPerM: number;
  outPerM: number;
  cacheReadPerM: number | null;
};

// Parse SupportedModels entries with Provider: "openrouter" out of llm.go.
// Entries are flat struct literals with no nested braces, so {[^{}]*} isolates
// one. We only need id + the three per-million fields we bill on.
export function parseCarriedOpenRouter(src: string): Carried[] {
  const out: Carried[] = [];
  for (const m of src.matchAll(/\{[^{}]*\}/g)) {
    const block = m[0];
    if (!/Provider:\s*"openrouter"/.test(block)) continue;
    const id = block.match(/ID:\s*"([^"]+)"/)?.[1];
    if (!id) continue;
    const num = (field: string): number | null => {
      const raw = block.match(new RegExp(`${field}:\\s*([\\d_]+)`))?.[1];
      if (raw == null) return null;
      const v = Number(raw.replace(/_/g, ""));
      return isFinite(v) ? v : null;
    };
    const input = num("InputPerMillion");
    const output = num("OutputPerMillion");
    const cacheRead = num("CacheReadPerMillion");
    if (input == null || output == null) continue;
    out.push({
      id,
      inPerM: microsToPerM(input),
      outPerM: microsToPerM(output),
      cacheReadPerM: cacheRead == null ? null : microsToPerM(cacheRead),
    });
  }
  return out;
}

type Envelope = { min: number; max: number; n: number };
type LiveFailKind = "DELIST" | "SKIP" | "ERROR";
type ModelLive =
  | { ok: true; in: Envelope; out: Envelope; cacheRead: Envelope | null; cheapestTag: string; nEndpoints: number }
  | { ok: false; reason: string; kind: LiveFailKind };

function envelope(values: number[]): Envelope | null {
  const v = values.filter((x) => isFinite(x) && x > 0);
  if (!v.length) return null;
  return { min: Math.min(...v), max: Math.max(...v), n: v.length };
}

async function fetchLive(id: string): Promise<ModelLive> {
  let res: Response;
  try {
    res = await fetch(ENDPOINTS_URL(id), { headers: { accept: "application/json" } });
  } catch (e) {
    return { ok: false, reason: `fetch threw: ${e instanceof Error ? e.message : String(e)}`, kind: "ERROR" };
  }
  if (res.status === 404) return { ok: false, reason: "404 — vanished from OpenRouter", kind: "DELIST" };
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, kind: "ERROR" };
  const json = (await res.json()) as { data?: { endpoints?: any[] } };
  const eps = json.data?.endpoints ?? [];
  // HTTP 200 with an empty endpoint list = a compound/meta model billed by
  // pass-through usage.cost (e.g. openrouter/fusion), which has no static
  // per-token price to diff. That's NOT a delist (the model still exists) —
  // skip it. A genuine delist 404s above.
  if (!eps.length) return { ok: false, reason: "no static endpoint pricing (pass-through/compound model — usage.cost billed)", kind: "SKIP" };

  const ins: number[] = [];
  const outs: number[] = [];
  const crs: number[] = [];
  let cheapestOut = Infinity;
  let cheapestTag = "?";
  for (const e of eps) {
    const p = e.pricing ?? {};
    const i = perTokenToPerM(p.prompt);
    const o = perTokenToPerM(p.completion);
    const c = perTokenToPerM(p.input_cache_read);
    if (i != null) ins.push(i);
    if (o != null) {
      outs.push(o);
      if (o < cheapestOut) {
        cheapestOut = o;
        cheapestTag = String(e.tag ?? e.provider_name ?? "?");
      }
    }
    if (c != null) crs.push(c);
  }
  const inEnv = envelope(ins);
  const outEnv = envelope(outs);
  if (!inEnv || !outEnv) return { ok: false, reason: "endpoints had no usable prices", kind: "ERROR" };
  return { ok: true, in: inEnv, out: outEnv, cacheRead: envelope(crs), cheapestTag, nEndpoints: eps.length };
}

// Relative tolerance to absorb $/token→$/M rounding. 0.5% is well below any
// real price move and above float noise.
const TOL = 0.005;
type Verdict = "OK" | "HIGH" | "LOW";
function classify(carried: number, env: Envelope): Verdict {
  if (carried > env.max * (1 + TOL)) return "HIGH"; // above every live endpoint → overbilling
  if (carried < env.min * (1 - TOL)) return "LOW"; // below cheapest → eating margin
  return "OK"; // inside the live spread → not drift
}
const fmt = (n: number | null) => (n == null ? "-" : "$" + (n >= 1 ? n.toFixed(2) : n.toPrecision(2)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
const env3 = (e: Envelope | null) => (e == null ? "-" : `${fmt(e.min)}..${fmt(e.max)}`);

export type DriftRow = {
  id: string;
  status: "DRIFT" | "DELIST" | "OK" | "SKIP" | "ERROR";
  detail: string;
  fields: { field: string; carried: number; envelope: string; verdict: Verdict }[];
};

export async function computeDrift(carried: Carried[]): Promise<DriftRow[]> {
  const rows: DriftRow[] = [];
  for (const c of carried) {
    const live = await fetchLive(c.id);
    if (!live.ok) {
      rows.push({ id: c.id, status: live.kind, detail: live.reason, fields: [] });
      continue;
    }
    const fields: DriftRow["fields"] = [
      { field: "in", carried: c.inPerM, env: live.in },
      { field: "out", carried: c.outPerM, env: live.out },
      ...(c.cacheReadPerM != null && live.cacheRead
        ? [{ field: "cache_read", carried: c.cacheReadPerM, env: live.cacheRead }]
        : []),
    ].map((f) => ({ field: f.field, carried: f.carried, envelope: env3(f.env), verdict: classify(f.carried, f.env) }));
    const bad = fields.filter((f) => f.verdict !== "OK");
    rows.push({
      id: c.id,
      status: bad.length ? "DRIFT" : "OK",
      detail: bad.length
        ? bad.map((f) => `${f.field} ${fmt(f.carried)} carried is ${f.verdict === "HIGH" ? "ABOVE" : "BELOW"} live ${f.envelope} (${live.nEndpoints} endpoints, cheapest ${live.cheapestTag})`).join("; ")
        : `all fields within live spread across ${live.nEndpoints} endpoints (cheapest ${live.cheapestTag})`,
      fields,
    });
  }
  return rows;
}

export async function collectOpenRouterDrift(spec: {
  kind: "openrouter_drift";
  llm_go?: string;
}): Promise<CollectorResult> {
  const path = spec.llm_go ?? "/home/dev/repos/vibes/apps/infra/internal/proxy/llm.go";
  let src: string;
  try {
    src = await readFile(path, "utf8");
  } catch (e) {
    return { title: "OpenRouter drift", body: `(could not read ${path}: ${e instanceof Error ? e.message : String(e)})`, ok: false, warning: "read failed" };
  }
  const carried = parseCarriedOpenRouter(src);
  if (!carried.length) {
    return { title: "OpenRouter drift", body: `(no Provider:"openrouter" entries parsed from ${path})`, ok: false, warning: "no entries" };
  }
  const rows = await computeDrift(carried);
  const drift = rows.filter((r) => r.status === "DRIFT");
  const delist = rows.filter((r) => r.status === "DELIST");
  const okCount = rows.filter((r) => r.status === "OK").length;
  const skip = rows.filter((r) => r.status === "SKIP" || r.status === "ERROR");

  // Sort actionable rows first so the agent reads them at the top.
  const order = { DRIFT: 0, DELIST: 1, SKIP: 2, ERROR: 3, OK: 4 } as const;
  const lines = [...rows].sort((a, b) => order[a.status] - order[b.status]).map((r) => `${r.status}\t${r.id}\t${r.detail}`);
  const verdict = drift.length || delist.length
    ? `*CONFIRMED: ${drift.length} drift, ${delist.length} delist, ${okCount} ok${skip.length ? `, ${skip.length} skip` : ""}.* ONLY DRIFT/DELIST rows are actionable — they are deterministic (carried price vs the live [min..max] envelope across ALL provider endpoints), NOT the flapping catalog floor. SKIP = pass-through/compound model with no static price; do not flag.`
    : `*No actionable drift: all ${okCount} carried OpenRouter prices sit within the live per-endpoint spread${skip.length ? ` (${skip.length} skipped — pass-through/compound, no static price)` : ""}.* A moving provider floor does NOT mean our pinned rate drifted — do NOT flag it.`;

  return {
    title: `OpenRouter drift (${drift.length} drift / ${delist.length} delist / ${okCount} ok)`,
    body: [verdict, "", "```", "status\tid\tdetail", ...lines, "```"].join("\n"),
    ok: true,
  };
}

// Runnable as a standalone script: `bun src/agents/collectors/openrouter-drift.ts [path/to/llm.go]`
// Exits non-zero when there is confirmed drift/delist, so it can gate CI.
if (import.meta.main) {
  const path = process.argv[2];
  const r = await collectOpenRouterDrift({ kind: "openrouter_drift", llm_go: path });
  console.log(r.body);
  const hasDrift = /^(DRIFT|DELIST)\t/m.test(r.body);
  process.exit(hasDrift ? 1 : 0);
}
