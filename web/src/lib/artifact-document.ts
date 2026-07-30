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
 * Theme bridge for scripted artifacts.
 *
 * Static artifacts inherit these values through their shadow host. A sandboxed
 * frame has its own document, so it receives the same semantic palette as
 * literal custom properties. This stylesheet is inserted before authored CSS:
 * an artifact's intentional colors still win, while unstyled/theme-aware
 * documents follow LFG automatically.
 */
function artifactThemeBridge(theme: ArtifactTheme): string {
  const variables = Object.entries(ARTIFACT_PALETTES[theme])
    .map(([name, value]) => `--lfg-artifact-${name}:${value}`)
    .join(";");
  return `<style id="lfg-artifact-theme">:root{color-scheme:${theme};${variables}}html,body{background:var(--lfg-artifact-surface);color:var(--lfg-artifact-foreground)}a{color:var(--lfg-artifact-accent)}</style>`;
}

/** Preserve the server's artifact sandbox and bridge the host theme into srcDoc. */
export function secureArtifactDocument(
  html: string,
  theme: ArtifactTheme = "light",
): string {
  const headContent = `${CSP_META}${artifactThemeBridge(theme)}`;
  const head = html.match(/<head(?:\s[^>]*)?>/i);
  if (head?.index !== undefined) {
    const insertAt = head.index + head[0].length;
    return `${html.slice(0, insertAt)}${headContent}${html.slice(insertAt)}`;
  }

  const root = html.match(/<html(?:\s[^>]*)?>/i);
  if (root?.index !== undefined) {
    const insertAt = root.index + root[0].length;
    return `${html.slice(0, insertAt)}<head>${headContent}</head>${html.slice(insertAt)}`;
  }

  return `<!doctype html><html><head>${headContent}</head><body>${html}</body></html>`;
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
