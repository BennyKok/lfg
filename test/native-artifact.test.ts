// Native artifact rendering: sanitizing contract + CSS scoping.
//
// The sanitizer is the security boundary that replaced the iframe sandbox, so it
// is tested against adversarial input AND against every real artifact currently
// on disk — the corpus is what told us native rendering was viable in the first
// place, so it is also what proves the parser handles it.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Window } from "happy-dom";

import {
  NATIVE_ARTIFACT_BASE_CSS,
  parseNativeArtifact,
  rewriteHostSelector,
} from "../web/src/lib/native-artifact.ts";

// `parseNativeArtifact` needs a DOM. happy-dom provides DOMParser; it does not
// implement constructable stylesheets, so `scopeArtifactCss` takes its documented
// fallback path here and the selector rewriting is asserted directly instead.
const window = new Window();
(globalThis as { DOMParser?: unknown }).DOMParser = window.DOMParser;

describe("rewriteHostSelector", () => {
  test("maps the document root onto :host", () => {
    expect(rewriteHostSelector("body")).toBe(":host");
    expect(rewriteHostSelector("html")).toBe(":host");
    expect(rewriteHostSelector(":root")).toBe(":host");
    expect(rewriteHostSelector("html body")).toBe(":host");
  });

  test("keeps root qualifiers as :host(...)", () => {
    expect(rewriteHostSelector("body.dark")).toBe(":host(.dark)");
    expect(rewriteHostSelector(':root[data-theme="x"]')).toBe(':host([data-theme="x"])');
  });

  test("rewrites descendants and explicit combinators", () => {
    expect(rewriteHostSelector("body h1")).toBe(":host h1");
    expect(rewriteHostSelector("body > .card")).toBe(":host > .card");
  });

  test("rewrites every selector in a list independently", () => {
    expect(rewriteHostSelector("body, .card, html h2")).toBe(":host, .card, :host h2");
  });

  test("leaves non-root selectors alone", () => {
    expect(rewriteHostSelector(".bodyguard")).toBe(".bodyguard");
    expect(rewriteHostSelector("table td")).toBe("table td");
    // A tag that merely starts with the same letters must not be captured.
    expect(rewriteHostSelector("bodyx h1")).toBe("bodyx h1");
  });
});

describe("parseNativeArtifact sanitizing", () => {
  test("removes scripts and reports that it did", () => {
    const out = parseNativeArtifact(
      "<html><body><h1>ok</h1><script>fetch('/api/steal')</script></body></html>",
    );
    expect(out.hasScripts).toBe(true);
    expect(out.html).not.toContain("script");
    expect(out.html).toContain("<h1>ok</h1>");
  });

  test("strips inline event handlers", () => {
    const out = parseNativeArtifact('<body><div onclick="alert(1)">x</div></body>');
    expect(out.hasScripts).toBe(true);
    expect(out.html).not.toContain("onclick");
  });

  test("strips javascript: urls, including obfuscated ones", () => {
    const plain = parseNativeArtifact('<body><a href="javascript:alert(1)">x</a></body>');
    expect(plain.html).not.toContain("javascript");
    expect(plain.hasScripts).toBe(true);

    // Browsers ignore control characters when resolving a scheme.
    const sneaky = parseNativeArtifact('<body><a href="java\nscript:alert(1)">x</a></body>');
    expect(sneaky.html).not.toContain("script:");
    expect(sneaky.hasScripts).toBe(true);
  });

  test("drops nested browsing contexts and document retargeting", () => {
    const out = parseNativeArtifact(
      '<body><iframe src="https://evil"></iframe><object data="x"></object>' +
        '<base href="https://evil/"><form action="/x"></form></body>',
    );
    for (const tag of ["iframe", "object", "base", "form"]) {
      expect(out.html).not.toContain(`<${tag}`);
    }
  });

  test("keeps links but forces them out of the app", () => {
    const out = parseNativeArtifact('<body><a href="https://example.com">x</a></body>');
    expect(out.html).toContain('target="_blank"');
    expect(out.html).toContain("noopener");
  });

  test("hoists style blocks out of the markup", () => {
    const out = parseNativeArtifact(
      "<html><head><style>body{margin:0}</style></head><body><p>x</p></body></html>",
    );
    expect(out.html).not.toContain("<style");
    expect(out.css).toContain("margin:0");
  });

  test("reads the document title", () => {
    const out = parseNativeArtifact("<html><head><title>Report</title></head><body>x</body></html>");
    expect(out.title).toBe("Report");
  });

  test("static artifacts are not reported as scripted", () => {
    const out = parseNativeArtifact(
      "<html><head><style>body{color:#111}</style></head><body><h1>hi</h1></body></html>",
    );
    expect(out.hasScripts).toBe(false);
  });
});

// The renderer choice is not a preference, it is a correctness property: a
// document whose content is drawn by scripts renders hollow in a shadow root.
describe("renderer selection", () => {
  const source = readFileSync("web/src/components/native-artifact.tsx", "utf8");

  test("a scripted artifact is framed automatically, with no user action", () => {
    // `hasScripts` from the parser is what selects the frame.
    expect(source).toMatch(/needsFrame\s*=\s*load\.status === "ready" && load\.value\.parsed\.hasScripts/);
    expect(source).toMatch(/if \(needsFrame && interactive\)/);
    expect(source).toContain('sandbox="allow-scripts"');
    // No opt-in control anywhere: the old behaviour made the user click first.
    expect(source).not.toMatch(/runIsolated|Run interactive|onClick=\{\(\) => set\w*Isolated/);
  });

  test("the frame reuses the fetched source instead of refetching", () => {
    expect(source).toContain("srcDoc={secureArtifactDocument(load.value.source)}");
  });

  test("thumbnails never frame, however scripted the artifact", () => {
    // A browsing context per tile is exactly what the native path exists to
    // avoid, so a gallery preview stays native and is badged instead.
    expect(source).toMatch(/interactive=\{false\}/);
    expect(source).toContain("Interactive");
  });

  test("a framed embed gets an explicit height", () => {
    // An <iframe> is 150px tall regardless of its document, so the
    // grow-to-content path cannot apply to it.
    expect(source).toMatch(/framed \? \{ height: maxHeight \}/);
  });
});

describe("the base stylesheet", () => {
  test("gives artifacts the white canvas the iframe used to provide", () => {
    // Artifacts routinely set `color:#111` and no background, relying on the
    // iframe's default canvas. Losing this makes them unreadable in dark mode.
    expect(NATIVE_ARTIFACT_BASE_CSS).toContain("background: #ffffff");
    expect(NATIVE_ARTIFACT_BASE_CSS).toContain("color-scheme: light");
  });
});

// The corpus check. `data/` is per-install, so this is skipped automatically in a
// fresh checkout and can be pointed at a populated install via the env var.
const CORPUS = process.env.LFG_ARTIFACT_CORPUS ?? "data/artifacts/files";
describe("real artifact corpus", () => {
  const files = existsSync(CORPUS)
    ? readdirSync(CORPUS).filter((f) => f.endsWith(".html"))
    : [];

  // Re-parse the sanitized markup and inspect real elements/attributes. Grepping
  // the serialized string instead would flag ordinary prose — "only =" matches a
  // naive /\son[a-z]+=/ event-handler pattern.
  const violations = (html: string): string[] => {
    const doc = new window.DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const found: string[] = [];
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      const tag = el.tagName.toLowerCase();
      if (["script", "iframe", "object", "embed", "base", "form", "link", "meta"].includes(tag)) {
        found.push(`<${tag}>`);
      }
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.toLowerCase().startsWith("on")) found.push(`@${attr.name}`);
        if (/^\s*javascript:/i.test(attr.value)) found.push(`${attr.name}=javascript:`);
      }
    }
    return found;
  };

  test.skipIf(files.length === 0)("every artifact parses to inert markup", () => {
    let scripted = 0;
    let rendered = 0;
    for (const name of files) {
      const source = readFileSync(join(CORPUS, name), "utf8");
      const out = parseNativeArtifact(source);
      if (out.hasScripts) scripted += 1;

      expect(violations(out.html), name).toEqual([]);

      // A sanitizer that returned "" for everything would satisfy the check
      // above, so require real content out of every non-trivial document.
      if (source.length > 800) {
        expect(out.html.length, name).toBeGreaterThan(0);
        rendered += 1;
      }
    }
    expect(rendered).toBeGreaterThan(0);
    // Sanity-check the premise of the whole design: scripting is the exception.
    expect(scripted / files.length).toBeLessThan(0.25);
  });
});
