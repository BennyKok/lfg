#!/usr/bin/env bun
// The dependency-advisory gate. Replaces the bare
//
//   bun audit --audit-level=high --ignore=GHSA-jfgx-wxx8-mp94
//
// that audit.yml used to run, for two reasons — one that had already bitten and
// one that was about to.
//
// 1. An `--ignore` flag has no exit condition. The workflow comment beside that
//    flag said the advisory covered `@mariozechner/pi-coding-agent >=0.50.0
//    <=0.73.1`, that 0.73.1 was the newest release, and so "there is no version
//    to upgrade to. Drop this ignore as soon as a fixed release exists."
//    All true when written. It stopped being true on 2026-06-04: pi was renamed
//    to `@earendil-works/pi-coding-agent` and patched in 0.78.1. Nothing was
//    watching, so for two months a green audit meant "we are suppressing a live,
//    fixable high-severity advisory" and read as "we are clean".
//
//    So every exception here is re-verified against the GitHub advisory API on
//    every run. An exception justified as `no-fix-available` fails the build the
//    moment upstream ships a fix — including one published under a *renamed
//    successor package*, which is exactly the case a naive check misses, since
//    our own package entry says `first_patched_version: null` and always will.
//    Every exception also carries a hard `reviewBy` date, so even a correctly
//    justified one cannot be sat on indefinitely.
//
// 2. `bun audit` resolves one lockfile at a time, and this repo has two bun
//    lockfiles. The old command ran at the root only, so `web/` — the dashboard
//    bundle that actually ships to browsers — was never audited at all.
//
// Run locally:
//   bun run audit                 # the gate
//   bun run audit -- --offline    # skip the advisory-API re-verification
//   bun run audit:exceptions      # re-record scripts/audit-exceptions.json
// CI: .github/workflows/audit.yml (push to main, every PR, Mondays 09:00 UTC)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` is Bun-only and undefined under some test runners; resolve
// from the module URL so the pure helpers below stay importable anywhere.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(SCRIPT_DIR, "..");
export const EXCEPTIONS_PATH = join(SCRIPT_DIR, "audit-exceptions.json");

/** Severities that fail the gate. Everything else is reported only. */
export const BLOCKING_SEVERITIES = ["high", "critical"] as const;

/** Every dependency graph `bun audit` can read here. One entry per bun lockfile. */
export const AUDIT_ROOTS: { dir: string; why: string }[] = [
  { dir: ".", why: "the CLI, agent backends and packages/* workspaces" },
  { dir: "web", why: "the dashboard bundle served to browsers — its own lockfile, and previously unaudited" },
];

/**
 * Lockfiles the gate knowingly does not cover, each with a reason. The coverage
 * test cross-checks the repo's real lockfile list against AUDIT_ROOTS plus this
 * one, so a new lockfile anywhere fails until someone picks a bucket for it.
 */
export const EXCLUDED_LOCKFILES: { file: string; why: string }[] = [
  {
    file: "mobile/package-lock.json",
    why: "npm lockfile — `bun audit` only reads bun.lock. Convert it to bun.lock and move it into AUDIT_ROOTS to bring the mobile app under the gate.",
  },
];

export type Severity = "info" | "low" | "moderate" | "high" | "critical";

/** One advisory as `bun audit --json` emits it, keyed by package name. */
export interface RawAdvisory {
  id: number;
  url: string;
  title: string;
  severity: Severity;
  vulnerable_versions: string;
}
export type BunAuditReport = Record<string, RawAdvisory[]>;

/** One (advisory, package, lockfile) tuple — the unit the gate reasons about. */
export interface Finding {
  ghsa: string;
  package: string;
  root: string;
  severity: Severity;
  title: string;
  vulnerableVersions: string;
}

export type Justification =
  /** Upstream has published no fixed version. Re-verified against the advisory API on every run. */
  | "no-fix-available"
  /** A fix exists; the upgrade is queued behind other work. Bounded by reviewBy. */
  | "backlog"
  /** Only reachable through a code path this repo does not use. */
  | "not-exploitable"
  /** The vulnerable version is deliberately pinned and the pin is load-bearing. */
  | "pinned";

export interface AcceptedEntry extends Finding {
  justification: Justification;
  reason: string;
  acceptedOn: string;
  reviewBy: string;
}

export interface Exceptions {
  $comment?: unknown;
  policy: { blockingSeverities: readonly string[]; defaultReviewDays: number };
  accepted: AcceptedEntry[];
}

/** Stable identity: the same advisory against the same package in the same lockfile. */
export function findingKey(f: Pick<Finding, "ghsa" | "package" | "root">): string {
  return `${f.root}|${f.package}|${f.ghsa}`;
}

export function ghsaFromUrl(url: string): string {
  const id = url.trim().replace(/\/+$/, "").split("/").pop() ?? "";
  if (!id.startsWith("GHSA-")) throw new Error(`advisory url has no GHSA id: ${url}`);
  return id;
}

export function isBlocking(severity: Severity): boolean {
  return (BLOCKING_SEVERITIES as readonly string[]).includes(severity);
}

/**
 * Flatten one `bun audit --json` report into findings. bun emits a duplicate
 * entry per resolution path, so findings de-duplicate on key.
 */
export function findingsFromReport(report: BunAuditReport, root: string): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const [pkg, advisories] of Object.entries(report ?? {})) {
    for (const advisory of advisories ?? []) {
      const finding: Finding = {
        ghsa: ghsaFromUrl(advisory.url),
        package: pkg,
        root,
        severity: advisory.severity,
        title: advisory.title,
        vulnerableVersions: advisory.vulnerable_versions,
      };
      byKey.set(findingKey(finding), finding);
    }
  }
  return [...byKey.values()].sort((a, b) => findingKey(a).localeCompare(findingKey(b)));
}

export interface Verdict {
  /** Blocking findings with no accepted exception — a PR added or exposed these. */
  unaccepted: Finding[];
  /** Exceptions past their reviewBy date. */
  expired: AcceptedEntry[];
  /** Exceptions whose advisory has left the graph — the record is stale. */
  stale: AcceptedEntry[];
  /** Blocking findings covered by a live exception. */
  accepted: { finding: Finding; entry: AcceptedEntry }[];
  /** Non-blocking findings, reported but never failing. */
  informational: Finding[];
}

/** The gate decision, pure in (graph, exceptions, date) so it tests without a network. */
export function evaluate(findings: Finding[], exceptions: Exceptions, today: string): Verdict {
  const entries = new Map(exceptions.accepted.map((e) => [findingKey(e), e]));
  const seen = new Set<string>();
  const verdict: Verdict = { unaccepted: [], expired: [], stale: [], accepted: [], informational: [] };

  for (const finding of findings) {
    const key = findingKey(finding);
    seen.add(key);
    if (!isBlocking(finding.severity)) {
      verdict.informational.push(finding);
      continue;
    }
    const entry = entries.get(key);
    if (!entry) {
      verdict.unaccepted.push(finding);
      continue;
    }
    verdict.accepted.push({ finding, entry });
    // An expired exception still counts as known, but it fails the run — the
    // point of the date is to force the decision back onto a human.
    if (entry.reviewBy < today) verdict.expired.push(entry);
  }

  for (const entry of exceptions.accepted) {
    if (!seen.has(findingKey(entry))) verdict.stale.push(entry);
  }
  return verdict;
}

/* ------------------------------------------------------------------ *
 * Exit-condition check: has upstream shipped a fix since we accepted?  *
 * ------------------------------------------------------------------ */

export interface AdvisoryVulnerability {
  package: { ecosystem: string; name: string };
  vulnerable_version_range: string | null;
  first_patched_version: string | null;
}
export interface AdvisoryRecord {
  ghsa_id: string;
  withdrawn_at: string | null;
  vulnerabilities: AdvisoryVulnerability[];
}

export interface FixInfo {
  /** Patched releases of the exact package we depend on (one per maintained branch). */
  directFix: string | null;
  /** A patched release published under a different, renamed package name. */
  successorFix: { package: string; version: string } | null;
  withdrawn: boolean;
}

/**
 * Read an advisory from the point of view of one package we depend on.
 *
 * The successor case is not hypothetical — it is the case this whole file
 * exists for. GHSA-jfgx-wxx8-mp94 lists `@mariozechner/pi-coding-agent` with
 * `first_patched_version: null` (the deprecated name will never be patched)
 * *and* `@earendil-works/pi-coding-agent` patched at 0.78.1. Reading only our
 * own entry reports "still no fix" forever, which is precisely how the old
 * `--ignore` flag stayed justified-looking after it stopped being justified.
 */
export function classifyFix(advisory: AdvisoryRecord, pkg: string): FixInfo {
  const vulns = advisory.vulnerabilities ?? [];
  // A package is often listed once per maintained release branch, each with its
  // own patched version. Report them all rather than pointing a 4.x consumer at
  // a 3.x backport.
  const mine = [
    ...new Set(
      vulns
        .filter((v) => v.package?.name === pkg && v.first_patched_version)
        .map((v) => v.first_patched_version as string),
    ),
  ];
  const successor = vulns.find((v) => v.package?.name !== pkg && v.first_patched_version);
  return {
    directFix: mine.length ? mine.join(" / ") : null,
    successorFix: successor
      ? { package: successor.package.name, version: successor.first_patched_version as string }
      : null,
    withdrawn: Boolean(advisory.withdrawn_at),
  };
}

/** A `no-fix-available` exception is only still honest while none of these hold. */
export function fixInvalidatesAcceptance(entry: AcceptedEntry, fix: FixInfo): string | null {
  if (entry.justification !== "no-fix-available") return null;
  if (fix.withdrawn) return "the advisory has been withdrawn — delete this entry";
  if (fix.directFix) return `fixed upstream in ${entry.package}@${fix.directFix} — upgrade and drop this entry`;
  if (fix.successorFix) {
    return `fixed under the renamed package ${fix.successorFix.package}@${fix.successorFix.version} — migrate and drop this entry`;
  }
  return null;
}

async function fetchAdvisory(ghsa: string, attempts = 3): Promise<AdvisoryRecord | null> {
  const url = `https://api.github.com/advisories/${ghsa}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "lfg-audit-gate",
  };
  // Advisory reads work unauthenticated, but CI shares an IP pool and gets
  // rate-limited fast; use the ambient token when there is one.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return (await res.json()) as AdvisoryRecord;
      // Anything 4xx that is not a rate limit is decisive: the id is wrong.
      if (res.status !== 403 && res.status !== 429 && res.status < 500) {
        console.error(`  advisory ${ghsa}: HTTP ${res.status} — cannot verify`);
        return null;
      }
    } catch (err) {
      console.error(`  advisory ${ghsa}: ${err instanceof Error ? err.message : err}`);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Runner                                                              *
 * ------------------------------------------------------------------ */

export function loadExceptions(path = EXCEPTIONS_PATH): Exceptions {
  const exceptions = JSON.parse(readFileSync(path, "utf8")) as Exceptions;
  if (!Array.isArray(exceptions.accepted)) throw new Error(`${path}: missing "accepted" array`);
  return exceptions;
}

async function auditRoot(dir: string): Promise<Finding[]> {
  const cwd = join(REPO_ROOT, dir);
  const proc = Bun.spawn(["bun", "audit", "--json"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  // `bun audit` exits 1 whenever it finds anything, so its exit code says
  // nothing about success. Unparseable stdout is the real failure signal — and
  // it is the one that matters, because an empty report reads exactly like
  // "clean".
  let report: BunAuditReport;
  try {
    report = JSON.parse(stdout || "{}") as BunAuditReport;
  } catch {
    throw new Error(`bun audit failed in ${dir || "."}:\n${stderr.trim() || stdout.trim()}`);
  }
  return findingsFromReport(report, dir);
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function summarize(lines: string[]) {
  const text = lines.join("\n");
  console.log(text);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      writeFileSync(summaryPath, `${text}\n`, { flag: "a" });
    } catch (err) {
      console.error(`could not write step summary: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const rewrite = args.includes("--update-exceptions");
  const offline = args.includes("--offline");

  const findings: Finding[] = [];
  for (const root of AUDIT_ROOTS) findings.push(...(await auditRoot(root.dir)));

  if (rewrite) {
    const existing = loadExceptions();
    const previous = new Map(existing.accepted.map((e) => [findingKey(e), e]));
    const reviewDays = existing.policy?.defaultReviewDays ?? 90;
    const accepted = findings
      .filter((f) => isBlocking(f.severity))
      .map<AcceptedEntry>((f) => {
        const prior = previous.get(findingKey(f));
        return {
          ...f,
          justification: prior?.justification ?? "backlog",
          reason:
            prior?.reason ??
            "Recorded automatically; no dedicated review yet. Upgrade or write a real justification before reviewBy.",
          acceptedOn: prior?.acceptedOn ?? today(),
          // Keep an existing clock rather than silently resetting it — a
          // re-record for an unrelated bump must not buy another 90 days.
          reviewBy: prior?.reviewBy ?? addDays(reviewDays),
        };
      });
    writeFileSync(EXCEPTIONS_PATH, `${JSON.stringify({ ...existing, accepted }, null, 2)}\n`);
    console.log(`exceptions updated: ${accepted.length} accepted advisories → ${EXCEPTIONS_PATH}`);
    return;
  }

  const exceptions = loadExceptions();
  const verdict = evaluate(findings, exceptions, today());

  const invalidated: { entry: AcceptedEntry; why: string }[] = [];
  const fixAvailable: { entry: AcceptedEntry; fix: FixInfo }[] = [];
  if (!offline) {
    // One advisory record covers every package it lists, so fetch per GHSA and
    // classify per entry.
    const ids = [...new Set(exceptions.accepted.map((e) => e.ghsa))];
    const advisories = new Map<string, AdvisoryRecord | null>();
    const CONCURRENCY = 8;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
        while (cursor < ids.length) {
          const ghsa = ids[cursor++];
          advisories.set(ghsa, await fetchAdvisory(ghsa));
        }
      }),
    );
    // The same (advisory, package) pair can appear under several lockfiles;
    // report it once.
    const unique = [...new Map(exceptions.accepted.map((e) => [`${e.ghsa}|${e.package}`, e])).values()];
    for (const entry of unique) {
      const advisory = advisories.get(entry.ghsa);
      if (!advisory) continue;
      const fix = classifyFix(advisory, entry.package);
      const why = fixInvalidatesAcceptance(entry, fix);
      if (why) invalidated.push({ entry, why });
      else if (fix.directFix || fix.successorFix) fixAvailable.push({ entry, fix });
    }
  }

  const lines: string[] = ["## Dependency advisory gate", ""];
  lines.push(
    `Audited ${AUDIT_ROOTS.length} lockfiles: **${verdict.unaccepted.length + verdict.accepted.length}** high/critical, ${verdict.informational.length} lower-severity.`,
    "",
  );

  const fail = (title: string, rows: string[]) => {
    lines.push(`### ❌ ${title}`, "", ...rows, "");
  };
  let failed = false;

  if (verdict.unaccepted.length) {
    failed = true;
    fail(`${verdict.unaccepted.length} unaccepted high/critical advisor${verdict.unaccepted.length === 1 ? "y" : "ies"}`, [
      "Not listed in `scripts/audit-exceptions.json`. Upgrade the dependency, or accept it",
      "explicitly — with a reason and a review date — via `bun run audit:exceptions`.",
      "",
      ...verdict.unaccepted.map((f) => `- \`${f.package}\` (${f.root}) — **${f.severity}** ${f.ghsa}: ${f.title}`),
    ]);
  }

  if (invalidated.length) {
    failed = true;
    fail(`${invalidated.length} exception${invalidated.length === 1 ? "" : "s"} now has a fix`, [
      "Accepted as `no-fix-available`. Upstream has since shipped one.",
      "",
      ...invalidated.map(({ entry, why }) => `- \`${entry.package}\` ${entry.ghsa}: ${why}`),
    ]);
  }

  if (verdict.expired.length) {
    failed = true;
    fail(`${verdict.expired.length} exception${verdict.expired.length === 1 ? "" : "s"} past review date`, [
      "The acceptance was time-boxed and the box has run out. Fix it, or re-accept it",
      "deliberately with a new date and a reason that reflects why it is still acceptable.",
      "",
      ...verdict.expired.map(
        (e) => `- \`${e.package}\` ${e.ghsa} — accepted ${e.acceptedOn}, review due ${e.reviewBy}: ${e.reason}`,
      ),
    ]);
  }

  if (verdict.stale.length) {
    failed = true;
    fail(`${verdict.stale.length} stale exception${verdict.stale.length === 1 ? "" : "s"}`, [
      "These advisories are gone from the graph — usually because someone fixed them.",
      "Run `bun run audit:exceptions` so the file keeps describing reality.",
      "",
      ...verdict.stale.map((e) => `- \`${e.package}\` (${e.root}) ${e.ghsa}`),
    ]);
  }

  if (fixAvailable.length) {
    lines.push(`### ⚠️ ${fixAvailable.length} accepted advisor${fixAvailable.length === 1 ? "y has" : "ies have"} an upstream fix available`, "");
    lines.push(
      ...fixAvailable.map(({ entry, fix }) => {
        const where = fix.directFix
          ? `${entry.package}@${fix.directFix}`
          : `${fix.successorFix?.package}@${fix.successorFix?.version}`;
        return `- \`${entry.package}\` ${entry.ghsa} → **${where}** (review by ${entry.reviewBy})`;
      }),
      "",
    );
  }

  if (verdict.accepted.length) {
    lines.push("<details><summary>Accepted high/critical advisories</summary>", "");
    lines.push(
      "| package | lockfile | severity | advisory | justification | review by |",
      "| --- | --- | --- | --- | --- | --- |",
      ...verdict.accepted.map(
        ({ finding, entry }) =>
          `| \`${finding.package}\` | ${finding.root} | ${finding.severity} | [${finding.ghsa}](https://github.com/advisories/${finding.ghsa}) | ${entry.justification} | ${entry.reviewBy} |`,
      ),
      "",
      "</details>",
      "",
    );
  }

  if (!failed) lines.push("### ✅ No unaccepted high/critical advisories", "");

  summarize(lines);
  if (failed) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(2);
  });
}
