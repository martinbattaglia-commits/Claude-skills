"use client";

import useSWR, { mutate as globalMutate, preload, type SWRConfiguration } from "swr";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`Request failed: ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json();
}

export function useResource<T>(key: string | null, config?: SWRConfiguration<T>) {
  return useSWR<T>(key, fetcher, config);
}

/**
 * Warm the SWR cache for a key before any component subscribes to it, so the
 * eventual `useResource(key)` mount renders instantly from cache. Errors are
 * swallowed — a failed prefetch just means the real mount pays the fetch.
 */
export function prefetchResource(key: string) {
  preload(key, fetcher).catch(() => {});
}

export function invalidate(key: string | RegExp) {
  if (typeof key === "string") return globalMutate(key);
  return globalMutate((k) => typeof k === "string" && key.test(k));
}
