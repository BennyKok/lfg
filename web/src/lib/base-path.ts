const rawBasePath = window.__LFG_BASE_PATH__ ?? "/";

export const basePath = rawBasePath === "/" ? "/" : rawBasePath.replace(/\/+$/, "/");

export function appPath(path: string): string {
  const clean = path.startsWith("/") ? path.slice(1) : path;
  if (!clean) return basePath;
  return basePath === "/" ? `/${clean}` : `${basePath}${clean}`;
}

export function appWebSocketUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${appPath(path)}`;
}
