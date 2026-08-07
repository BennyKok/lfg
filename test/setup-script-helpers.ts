import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SETUP_SH = join(import.meta.dir, "..", "scripts", "setup.sh");

/**
 * setup.sh is a single top-to-bottom installer, so the only way to exercise one
 * of its helpers is to slice the function definition out and source it. The
 * slice is by name, so a rename surfaces as a failing test rather than a test
 * that silently stops covering anything.
 */
export function extractFunctionSource(name: string): string {
  const lines = readFileSync(SETUP_SH, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith(`${name}() {`));
  expect(start, `${name}() not found in scripts/setup.sh`).toBeGreaterThanOrEqual(0);
  const opener = lines[start];
  // A one-liner (`f() { ...; }`) is its own body; otherwise scan to the closing
  // brace at the definition's indentation.
  if (opener.trimEnd().endsWith("}")) return opener;
  const indent = opener.length - opener.trimStart().length;
  const end = lines.findIndex((l, i) => i > start && l === `${" ".repeat(indent)}}`);
  expect(end, `end of ${name}() not found in scripts/setup.sh`).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join("\n");
}
