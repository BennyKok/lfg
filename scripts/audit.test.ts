import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AUDIT_ROOTS,
  EXCLUDED_LOCKFILES,
  REPO_ROOT,
  type AcceptedEntry,
  type AdvisoryRecord,
  type Exceptions,
  classifyFix,
  evaluate,
  findingKey,
  findingsFromReport,
  fixInvalidatesAcceptance,
  ghsaFromUrl,
  isBlocking,
} from "./audit.ts";

function entry(over: Partial<AcceptedEntry> = {}): AcceptedEntry {
  return {
    ghsa: "GHSA-aaaa-bbbb-cccc",
    package: "left-pad",
    root: ".",
    severity: "high",
    title: "left-pad pads left",
    vulnerableVersions: "<1.0.0",
    justification: "backlog",
    reason: "queued",
    acceptedOn: "2026-01-01",
    reviewBy: "2026-12-31",
    ...over,
  };
}

const exceptionsOf = (accepted: AcceptedEntry[]): Exceptions => ({
  policy: { blockingSeverities: ["high", "critical"], defaultReviewDays: 90 },
  accepted,
});

const advisory = (over: Partial<Parameters<typeof findingsFromReport>[0][string][number]> = {}) => ({
  id: 1,
  url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  title: "left-pad pads left",
  severity: "high" as const,
  vulnerable_versions: "<1.0.0",
  ...over,
});

describe("audit gate", () => {
  test("fails on high/critical advisories that are not accepted", () => {
    const findings = findingsFromReport(
      {
        "left-pad": [advisory()],
        "right-pad": [
          advisory({
            id: 2,
            url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
            title: "right-pad pads right",
            severity: "critical",
          }),
        ],
      },
      ".",
    );

    const verdict = evaluate(findings, exceptionsOf([entry()]), "2026-08-02");
    expect(verdict.unaccepted.map((f) => f.ghsa)).toEqual(["GHSA-dddd-eeee-ffff"]);
    expect(verdict.accepted.map((a) => a.finding.ghsa)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    expect(verdict.expired).toEqual([]);
    expect(verdict.stale).toEqual([]);
  });

  test("reports lower-severity advisories without failing", () => {
    const findings = findingsFromReport({ "low-risk": [advisory({ severity: "moderate" })] }, ".");
    const verdict = evaluate(findings, exceptionsOf([]), "2026-08-02");
    expect(verdict.unaccepted).toEqual([]);
    expect(verdict.informational).toHaveLength(1);
    expect(isBlocking("moderate")).toBe(false);
    expect(isBlocking("critical")).toBe(true);
  });

  test("an exception expires on its review date rather than lasting forever", () => {
    const findings = findingsFromReport({ "left-pad": [advisory()] }, ".");
    const timeboxed = exceptionsOf([entry({ reviewBy: "2026-08-01" })]);
    expect(evaluate(findings, timeboxed, "2026-08-01").expired).toEqual([]);
    expect(evaluate(findings, timeboxed, "2026-08-02").expired).toHaveLength(1);
  });

  test("an exception whose advisory has left the graph is reported as stale", () => {
    expect(evaluate([], exceptionsOf([entry()]), "2026-08-02").stale.map((e) => e.ghsa)).toEqual([
      "GHSA-aaaa-bbbb-cccc",
    ]);
  });

  test("the same advisory in two lockfiles is tracked separately", () => {
    // bun emits one entry per resolution path; the gate counts the advisory once.
    const root = findingsFromReport({ "left-pad": [advisory(), advisory()] }, ".");
    const web = findingsFromReport({ "left-pad": [advisory()] }, "web");
    expect(root).toHaveLength(1);
    expect(findingKey(root[0])).not.toBe(findingKey(web[0]));

    // Accepting it at the root must not silently accept it in web/.
    const verdict = evaluate([...root, ...web], exceptionsOf([entry()]), "2026-08-02");
    expect(verdict.unaccepted.map((f) => f.root)).toEqual(["web"]);
  });

  test("ghsa ids come from the advisory url and a malformed url is loud", () => {
    expect(ghsaFromUrl("https://github.com/advisories/GHSA-aaaa-bbbb-cccc")).toBe("GHSA-aaaa-bbbb-cccc");
    expect(ghsaFromUrl("https://github.com/advisories/GHSA-aaaa-bbbb-cccc/")).toBe("GHSA-aaaa-bbbb-cccc");
    expect(() => ghsaFromUrl("https://nvd.nist.gov/vuln/detail/CVE-2026-1")).toThrow("no GHSA id");
  });
});

describe("exception exit conditions", () => {
  // The exact regression this mechanism exists to prevent. Our own package
  // entry says `first_patched_version: null` and always will, because the fix
  // shipped under a renamed package. That is what let `--ignore` look justified
  // for two months after it stopped being justified.
  const RENAMED_PACKAGE_ADVISORY: AdvisoryRecord = {
    ghsa_id: "GHSA-jfgx-wxx8-mp94",
    withdrawn_at: null,
    vulnerabilities: [
      {
        package: { ecosystem: "npm", name: "@earendil-works/pi-coding-agent" },
        vulnerable_version_range: ">= 0.74.0, < 0.78.1",
        first_patched_version: "0.78.1",
      },
      {
        package: { ecosystem: "npm", name: "@mariozechner/pi-coding-agent" },
        vulnerable_version_range: ">= 0.50.0, <= 0.73.1",
        first_patched_version: null,
      },
    ],
  };

  test("a fix under a renamed successor package invalidates a no-fix-available exception", () => {
    const fix = classifyFix(RENAMED_PACKAGE_ADVISORY, "@mariozechner/pi-coding-agent");
    expect(fix.directFix).toBeNull();
    expect(fix.successorFix).toEqual({ package: "@earendil-works/pi-coding-agent", version: "0.78.1" });

    const accepted = entry({
      ghsa: "GHSA-jfgx-wxx8-mp94",
      package: "@mariozechner/pi-coding-agent",
      justification: "no-fix-available",
    });
    expect(fixInvalidatesAcceptance(accepted, fix)).toContain("@earendil-works/pi-coding-agent@0.78.1");
  });

  test("a package patched on several release branches reports every fixed version", () => {
    const fix = classifyFix(
      {
        ghsa_id: "GHSA-52cp-r559-cp3m",
        withdrawn_at: null,
        vulnerabilities: [
          { package: { ecosystem: "npm", name: "js-yaml" }, vulnerable_version_range: "<3.15.0", first_patched_version: "3.15.0" },
          { package: { ecosystem: "npm", name: "js-yaml" }, vulnerable_version_range: ">=4.0.0 <4.3.0", first_patched_version: "4.3.0" },
        ],
      },
      "js-yaml",
    );
    expect(fix.directFix).toBe("3.15.0 / 4.3.0");
    expect(fix.successorFix).toBeNull();
  });

  test("a direct upstream fix or a withdrawal invalidates a no-fix-available exception", () => {
    const accepted = entry({ justification: "no-fix-available" });
    expect(fixInvalidatesAcceptance(accepted, { directFix: "1.0.1", successorFix: null, withdrawn: false })).toContain(
      "left-pad@1.0.1",
    );
    expect(fixInvalidatesAcceptance(accepted, { directFix: null, successorFix: null, withdrawn: true })).toContain(
      "withdrawn",
    );
    expect(fixInvalidatesAcceptance(accepted, { directFix: null, successorFix: null, withdrawn: false })).toBeNull();
  });

  test("an available fix does not fail a backlog exception — only the review date does", () => {
    expect(
      fixInvalidatesAcceptance(entry({ justification: "backlog" }), {
        directFix: "1.0.1",
        successorFix: null,
        withdrawn: false,
      }),
    ).toBeNull();
  });
});

describe("audit coverage", () => {
  test("every lockfile in the repo is either audited or excluded with a reason", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f));
    expect(tracked.length).toBeGreaterThan(0);

    const audited = new Set(AUDIT_ROOTS.map((r) => (r.dir === "." ? "bun.lock" : `${r.dir}/bun.lock`)));
    const excluded = new Set(EXCLUDED_LOCKFILES.map((e) => e.file));
    expect(tracked.filter((f) => !audited.has(f) && !excluded.has(f))).toEqual([]);

    // Both lists must name files that exist, so a rename cannot leave a
    // lockfile silently unaudited behind a stale entry.
    for (const lockfile of [...audited, ...excluded]) expect(tracked).toContain(lockfile);
    for (const e of EXCLUDED_LOCKFILES) expect(e.why.length).toBeGreaterThan(20);
  });

  test("the committed exception list is well-formed and every entry is justified", () => {
    const exceptions = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/audit-exceptions.json"), "utf8"),
    ) as Exceptions;

    const justifications = new Set(["no-fix-available", "backlog", "not-exploitable", "pinned"]);
    const roots = new Set(AUDIT_ROOTS.map((r) => r.dir));
    const keys = new Set<string>();

    for (const e of exceptions.accepted) {
      expect(justifications.has(e.justification)).toBe(true);
      expect(roots.has(e.root)).toBe(true);
      expect(e.ghsa.startsWith("GHSA-")).toBe(true);
      // A one-word reason is how an exception becomes permanent by accident.
      expect(e.reason.length).toBeGreaterThan(40);
      expect(e.acceptedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.reviewBy > e.acceptedOn).toBe(true);
      expect(exceptions.policy.blockingSeverities).toContain(e.severity);
      const key = findingKey(e);
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
  });

  test("no bare --ignore flag has crept back into the audit workflow", () => {
    // The flag this mechanism replaced. Reintroducing it re-creates an
    // exception with no reason, no review date and no exit condition.
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/audit.yml"), "utf8");
    const commands = workflow
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(commands).not.toContain("--ignore=");
    expect(commands).toContain("scripts/audit.ts");
  });
});
