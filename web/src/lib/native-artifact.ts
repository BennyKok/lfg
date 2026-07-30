// Native (iframe-free) rendering for HTML artifacts.
//
// WHY THIS EXISTS. Artifacts used to be rendered by fetching the document and
// handing it to `<iframe srcDoc sandbox="allow-scripts">`. That bought process
// isolation nobody was using: of the HTML artifacts agents actually publish,
// ~95% are a `<style>` block plus static markup — reports, tables, timelines.
// The iframe cost was real though: a separate document per artifact (so the
// Artifacts gallery booted a wall of them), no HTTP caching, no natural height
// (hence a postMessage reporter polling `scrollHeight` every second, per tile),
// and a rendering surface that could never inherit the host's scroll, text
// selection, or theme.
//
// So: parse the document with `DOMParser` (inert — no scripts run, no
// subresources load while detached), strip everything executable, and hand the
// result to a shadow root. Shadow DOM is what makes this safe to do *natively*:
// the artifact's `<style>` cannot leak out into LFG's UI and LFG's Tailwind
// reset cannot leak in, which is the only property the iframe was really
// providing for a static document.
//
// WHAT WE DO NOT DO: run artifact JavaScript in the host origin. `innerHTML`
// already refuses to execute `<script>`, and we strip scripts and inline
// handlers explicitly on top of that, so an artifact can never reach the
// session's cookies or DOM. Artifacts that genuinely need scripting are
// reported via `hasScripts` and the caller offers an explicit opt-in that
// boots the old sandboxed frame on demand.

/** Elements that can execute code, load a nested browsing context, or retarget the document. */
const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "noscript",
  // A same-document form post inside a shadow root would navigate the whole app.
  "form",
]);

/** URL-bearing attributes that must be checked for `javascript:` payloads. */
const URL_ATTRS = ["href", "src", "srcset", "xlink:href", "action", "formaction", "poster"];

const SAFE_URL = /^(?:https?:|mailto:|tel:|data:image\/|#|\/|\.{0,2}\/)/i;

export type NativeArtifactDocument = {
  /** Sanitized body markup, ready for a shadow root. */
  html: string;
  /** Stylesheet text collected from the document, rewritten for the shadow boundary. */
  css: string;
  /** True when the source document contained scripting we removed. */
  hasScripts: boolean;
  /** `<title>` if the document declared one. */
  title: string | null;
};

/**
 * `body` / `html` / `:root` do not exist inside a shadow root, but essentially
 * every artifact styles the page through them (`body{max-width:720px;margin:24px
 * auto}`). Map them onto `:host` so the authored layout survives.
 */
export function rewriteHostSelector(selector: string): string {
  return selector
    .split(",")
    .map((part) => {
      const s = part.trim();
      if (!s) return s;
      // `html`, `body`, `:root`, `html body` — the document root itself.
      if (/^(?:html|body|:root)(?:\s+(?:html|body))?$/i.test(s)) return ":host";
      // `body.dark`, `html[data-theme="x"]`, `:root.foo` — root with qualifiers.
      const qualified = s.match(/^(?:html|body|:root)((?:[.#[:][^\s>+~]*)+)$/i);
      if (qualified) return `:host(${qualified[1]})`;
      // `body > .card`, `:root + x` — explicit combinator off the root.
      const child = s.match(/^(?:html|body|:root)\s*([>+~])\s*(.*)$/i);
      if (child) return `:host ${child[1]} ${child[2]}`;
      // `body h1` — plain descendant of the root.
      const descendant = s.match(/^(?:html|body|:root)\s+(.*)$/i);
      if (descendant) return `:host ${descendant[1]}`;
      return s;
    })
    .join(", ");
}

/**
 * Rewrite root selectors throughout a stylesheet using the browser's own CSS
 * parser, so nested `@media` / `@supports` / `@layer` blocks are handled without
 * us hand-rolling a tokenizer. Falls back to the raw text if the sheet cannot be
 * parsed.
 */
export function scopeArtifactCss(css: string): string {
  if (typeof CSSStyleSheet === "undefined") return css;
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    // `replaceSync` also drops @import, which is exactly what we want.
    sheet.replaceSync(css);
  } catch {
    return css;
  }

  const rewrite = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if ("selectorText" in rule && typeof (rule as CSSStyleRule).selectorText === "string") {
        const styleRule = rule as CSSStyleRule;
        const next = rewriteHostSelector(styleRule.selectorText);
        if (next !== styleRule.selectorText) {
          try {
            styleRule.selectorText = next;
          } catch {
            // Some engines reject a selector they cannot reparse; keeping the
            // original is a cosmetic loss, not a correctness one.
          }
        }
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) rewrite(nested);
    }
  };

  try {
    rewrite(sheet.cssRules);
    return Array.from(sheet.cssRules)
      .map((r) => r.cssText)
      .join("\n");
  } catch {
    return css;
  }
}

function isSafeUrl(value: string): boolean {
  // Browsers ignore ASCII whitespace and control characters when resolving a
  // scheme, so a newline inside "java\nscript:" still navigates. Strip the whole
  // C0 range plus space before testing, not just the outer edges.
  const normalized = value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (!normalized) return true;
  return SAFE_URL.test(normalized);
}

function isScriptUrl(value: string): boolean {
  return value.replace(/[\u0000-\u0020]/g, "").toLowerCase().startsWith("javascript:");
}

/**
 * Parse an artifact document and return inert, shadow-root-ready markup.
 *
 * Runs on a detached `DOMParser` document: nothing executes and no subresource
 * is requested until the caller attaches the result.
 */
export function parseNativeArtifact(source: string): NativeArtifactDocument {
  if (typeof DOMParser === "undefined") {
    return { html: "", css: "", hasScripts: /<script/i.test(source), title: null };
  }

  const parsed = new DOMParser().parseFromString(source, "text/html");
  let hasScripts = false;

  // Stylesheets first: `<style>` nodes are removed from the markup and merged so
  // the shadow root can adopt a single parsed sheet instead of N style elements.
  const cssChunks: string[] = [];
  for (const style of Array.from(parsed.querySelectorAll("style"))) {
    cssChunks.push(style.textContent ?? "");
    style.remove();
  }

  for (const el of Array.from(parsed.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();

    if (FORBIDDEN_TAGS.has(tag)) {
      if (tag === "script") hasScripts = true;
      el.remove();
      continue;
    }
    // External stylesheets and preloads: dropped. The artifact CSP already
    // blocked them, so nothing can be relying on one.
    if (tag === "link") {
      el.remove();
      continue;
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        // `onclick="..."` and friends are script by another name.
        hasScripts = true;
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name) && !isSafeUrl(attr.value)) {
        if (isScriptUrl(attr.value)) hasScripts = true;
        el.removeAttribute(attr.name);
      }
    }

    // Anchors resolve against the host document, so make every link an explicit
    // new-tab navigation rather than letting it replace the app.
    if (tag === "a" && el.getAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }

  return {
    html: parsed.body?.innerHTML ?? "",
    css: scopeArtifactCss(cssChunks.join("\n")),
    hasScripts,
    title: parsed.title?.trim() || null,
  };
}

/**
 * Baseline styles applied *before* the artifact's own CSS.
 *
 * Two jobs. The shadow boundary blocks LFG's selectors but not inherited
 * properties, so font/color are reset to a neutral document default instead of
 * whatever the surrounding UI was using. And artifacts overwhelmingly assume the
 * white canvas an iframe gave them for free (`color:#111` with no background),
 * so the host paints paper-white unless the artifact sets its own background.
 */
export const NATIVE_ARTIFACT_BASE_CSS = `
:host {
  display: block;
  background: #ffffff;
  color: #111111;
  color-scheme: light;
  font: 16px/1.5 system-ui, -apple-system, sans-serif;
  text-align: left;
  overflow-wrap: break-word;
}
:host * { box-sizing: border-box; }
img, svg, video, canvas { max-width: 100%; height: auto; }
table { max-width: 100%; }
pre { overflow: auto; }
a { color: #1d4ed8; }
`;
