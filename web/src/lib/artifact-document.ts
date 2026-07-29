const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

/** Preserve the server's artifact sandbox after authenticated fetch turns the response into srcDoc. */
export function secureArtifactDocument(html: string): string {
  const head = html.match(/<head(?:\s[^>]*)?>/i);
  if (head?.index !== undefined) {
    const insertAt = head.index + head[0].length;
    return `${html.slice(0, insertAt)}${CSP_META}${html.slice(insertAt)}`;
  }

  const root = html.match(/<html(?:\s[^>]*)?>/i);
  if (root?.index !== undefined) {
    const insertAt = root.index + root[0].length;
    return `${html.slice(0, insertAt)}<head>${CSP_META}</head>${html.slice(insertAt)}`;
  }

  return `<!doctype html><html><head>${CSP_META}</head><body>${html}</body></html>`;
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
