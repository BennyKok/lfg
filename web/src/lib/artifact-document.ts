const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

export type ArtifactTheme = "light" | "dark";

const ARTIFACT_PALETTES: Record<ArtifactTheme, Record<string, string>> = {
  light: {
    background: "#f2f2f7",
    surface: "#ffffff",
    foreground: "#000000",
    muted: "#f9f9fb",
    "muted-foreground": "rgba(60, 60, 67, 0.6)",
    border: "rgba(60, 60, 67, 0.12)",
    accent: "#007aff",
    "accent-foreground": "#ffffff",
    "code-background": "rgba(120, 120, 128, 0.08)",
  },
  dark: {
    background: "#000000",
    surface: "#1c1c1e",
    foreground: "#ffffff",
    muted: "#2c2c2e",
    "muted-foreground": "rgba(235, 235, 245, 0.6)",
    border: "rgba(84, 84, 88, 0.35)",
    accent: "#0a84ff",
    "accent-foreground": "#ffffff",
    "code-background": "rgba(118, 118, 128, 0.16)",
  },
};

/**
 * Shorthands for the three tokens artifacts reach for most, published alongside
 * the canonical names.
 *
 * An artifact that guesses `--omg-artifact-bg` gets nothing back and silently
 * falls through to its own hardcoded fallback — which is how a card ends up
 * with OMG's dark surfaces and the artifact's light text. Answering the common
 * guess costs three declarations. `muted-fg` is here because the near miss is
 * the expensive one: `--omg-artifact-muted` exists but is a *surface*, so text
 * painted with it disappears into its own background.
 */
const ARTIFACT_ALIASES: Record<string, string> = {
  bg: "background",
  fg: "foreground",
  "muted-fg": "muted-foreground",
};

// Token prefixes, new first. Artifacts published before the OMG rename hardcode
// `--lfg-artifact-*` and are still served from disk by this same bridge, so both
// prefixes are emitted with identical values — an old card must not lose its
// theming because the brand changed. New artifacts are told about `--omg-*` only.
const ARTIFACT_TOKEN_PREFIXES = ["--omg-artifact-", "--lfg-artifact-"] as const;

/**
 * Theme bridge for scripted artifacts.
 *
 * Static artifacts inherit these values through their shadow host. A sandboxed
 * frame has its own document, so it receives the same semantic palette as
 * literal custom properties. This stylesheet is inserted before authored CSS:
 * an artifact's intentional colors still win, while unstyled/theme-aware
 * documents follow OMG automatically.
 */
function artifactThemeBridge(theme: ArtifactTheme): string {
  const palette = ARTIFACT_PALETTES[theme];
  const variables = ARTIFACT_TOKEN_PREFIXES.flatMap((prefix) => [
    ...Object.entries(palette).map(([name, value]) => `${prefix}${name}:${value}`),
    ...Object.entries(ARTIFACT_ALIASES).map(([alias, name]) => `${prefix}${alias}:${palette[name]}`),
  ]).join(";");
  return `<style id="omg-artifact-theme">:root{color-scheme:${theme};${variables}}html,body{background:var(--omg-artifact-surface);color:var(--omg-artifact-foreground)}a{color:var(--omg-artifact-accent)}</style>`;
}

/**
 * Stamp the card's theme where CSS can select on it.
 *
 * A card is themed by LFG, not by the desktop, so `prefers-color-scheme` inside
 * the frame answers the wrong question: a dark card on a light machine renders
 * the artifact's light branch over dark surfaces. `data-theme` is the marker
 * artifacts can key on instead, and it matches what the native renderer already
 * rewrites `:root[data-theme=…]` into for the shadow path.
 */
function withThemeAttribute(tag: string, theme: ArtifactTheme): string {
  if (/\sdata-theme\s*=/i.test(tag)) return tag;
  return `${tag.replace(/\s*\/?>$/, "")} data-theme="${theme}">`;
}

/** Preserve the server's artifact sandbox and bridge the host theme into srcDoc. */
export function secureArtifactDocument(
  html: string,
  theme: ArtifactTheme = "light",
): string {
  const headContent = `${CSP_META}${artifactThemeBridge(theme)}`;
  const root = html.match(/<html(?:\s[^>]*)?>/i);
  const themed = root?.index !== undefined
    ? `${html.slice(0, root.index)}${withThemeAttribute(root[0], theme)}${html.slice(root.index + root[0].length)}`
    : html;

  const head = themed.match(/<head(?:\s[^>]*)?>/i);
  if (head?.index !== undefined) {
    const insertAt = head.index + head[0].length;
    return `${themed.slice(0, insertAt)}${headContent}${themed.slice(insertAt)}`;
  }

  const themedRoot = themed.match(/<html(?:\s[^>]*)?>/i);
  if (themedRoot?.index !== undefined) {
    const insertAt = themedRoot.index + themedRoot[0].length;
    return `${themed.slice(0, insertAt)}<head>${headContent}</head>${themed.slice(insertAt)}`;
  }

  return `<!doctype html><html data-theme="${theme}"><head>${headContent}</head><body>${themed}</body></html>`;
}

export function artifactRequestPath(
  path: string,
  query: Record<string, string | number | undefined> = {},
): string {
  const [base, rawQuery = ""] = path.split("?", 2);
  const params = new URLSearchParams(rawQuery);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${base}?${suffix}` : base;
}
