export async function fetchBootstrap<T>(): Promise<T> {
  const res = await fetch("/api/bootstrap");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error || `${res.status}`);
  }
  return data as T;
}
