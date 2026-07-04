"use client";

import { useEffect, useState } from "react";

// Per-device persisted state in localStorage. SSR-safe: renders from `initial`,
// then hydrates from localStorage after mount (one tick — same settle the old
// settings fetch had), so there's no hydration mismatch. Writes through on set.
//
// Use for view state that should be remembered ON THIS device but NOT synced
// across devices (the device usually implies the use case). For genuinely
// cross-device preferences, persist server-side instead.
export function useLocalStorageState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch {
      // private mode / malformed JSON — fall back to `initial`
    }
  }, [key]);

  const set = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // storage unavailable — keep the in-memory value
    }
  };

  return [value, set];
}
