// Bounded-concurrency map: run `fn` over `items` with at most `concurrency`
// in-flight, preserving input order in the result. Used by the SEC enrichment /
// holdings jobs to stay under provider rate limits without going fully serial.

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, worker),
  );
  return out;
}
