/** Deduplicate React development-mode requests and cache successful catalogs.
 * Failed requests are never cached, so an explicit retry can recover. */
export function catalogCache<T>(load: () => Promise<T>, lifetime = 5 * 60 * 1000): () => Promise<T> {
  let cached: { value: T; until: number } | null = null;
  let pending: Promise<T> | null = null;
  return () => {
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = load().then(value => { cached = { value, until: Date.now() + lifetime }; return value; }).finally(() => { pending = null; });
    return pending;
  };
}
