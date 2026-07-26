// Recurrence matching for auto-agent findings.
//
// These cases are not invented — they are real titles from data/auto/findings.jsonl.
// The watch agents correctly reported the sqld WAL failure on 2026-07-12 and the
// snapshot accumulation repeatedly through 07-20/21/22. Every one of those repeats
// was filed as a BRAND NEW finding and the persistence signal was lost, because
// the old dedup required an exact title match and only looked at "open"/"dismissed"
// (302 of 396 findings were sitting in "session"). The WAL problem then caused a
// four-day backup outage on 07-22.
//
// So the two properties under test are the two that actually failed in production:
//   1. the same problem re-reported with a MOVED NUMBER must match
//   2. genuinely different problems must NOT match

import { expect, test } from "bun:test";
import { normTitleForTest as normTitle } from "./store.ts";

const same = (a: string, b: string) => normTitle(a) === normTitle(b);

test("same problem with a grown number is one finding, not two", () => {
  expect(
    same(
      "Orchestrator sqld WAL is 2.3 GB (600× data file) — checkpoints not truncating",
      "Orchestrator sqld WAL is 3.1 GB (712× data file) — checkpoints not truncating",
    ),
  ).toBe(true);
});

test("snapshot accumulation re-reported with new counts is one finding", () => {
  expect(
    same(
      "Orch user_project snapshots: 2772 unreferenced hold 1.60 TB on Tigris",
      "Orch user_project snapshots: 2984 unreferenced hold 1.26 TB on Tigris",
    ),
  ).toBe(true);
});

test("unrelated findings stay separate", () => {
  expect(
    same(
      "Publish button hardcodes `color: \"#FBF8F2\"`",
      "Orchestrator sqld WAL is 2.3 GB — checkpoints not truncating",
    ),
  ).toBe(false);
});

test("differing units do not collapse unrelated metrics", () => {
  expect(
    same(
      "tigris.upload_snapshot p95 regression: ~60s → ~450s",
      "processedWebhooks has no GC — 59k rows, 27% of CP DB",
    ),
  ).toBe(false);
});

test("whitespace and punctuation noise does not create a new finding", () => {
  expect(
    same(
      "Orchestrator sqld WAL is 2.3 GB  —  checkpoints not truncating",
      "Orchestrator sqld WAL is 2.3GB - checkpoints not truncating",
    ),
  ).toBe(true);
});
