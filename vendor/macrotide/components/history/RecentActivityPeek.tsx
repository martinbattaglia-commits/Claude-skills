"use client";

// RecentActivityPeek — "Recently recorded" on the Portfolio glance (design A ·
// §5). Three most-recent ledger lines as read-only EventLines, with an "all
// history ›" link that proves the home and the ledger are the same material.
// Renders nothing until there's activity.

import { useMemo } from "react";
import { EventLine } from "@/components/history/EventLine";
import { Icon } from "@/components/Icon";
import type { Transaction } from "@/lib/db/queries/transactions";
import { useResource } from "@/lib/fetchers/swr";
import type { TransactionAnalytics } from "@/lib/portfolio/transaction-analytics";

type AnalyticsResponse = TransactionAnalytics & { transactionCount: number };

export function RecentActivityPeek({
  bucketId,
  onSeeAll,
}: {
  /** Active portfolio's bucket — scopes the peek to it; `undefined` shows all. */
  bucketId?: string;
  onSeeAll: () => void;
}) {
  const { data: txns } = useResource<Transaction[]>("/api/transactions");
  const { data: analytics } = useResource<AnalyticsResponse>("/api/transactions/analytics");

  const realizedByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of analytics?.realized ?? []) m.set(`${e.ticker}|${e.tradeDate}`, e.realizedGain);
    return m;
  }, [analytics]);

  // The API returns the ledger oldest-first (tradeDate, id); the tail is newest.
  // Scope to the active portfolio's bucket first so the peek matches the screen.
  const recent = useMemo(() => {
    const scoped = bucketId ? (txns ?? []).filter((t) => t.bucketId === bucketId) : (txns ?? []);
    return scoped.slice(-3).reverse();
  }, [txns, bucketId]);
  if (recent.length === 0) return null;

  return (
    <div className="recent-peek">
      <div className="section-header" style={{ padding: "0 20px", marginTop: 18, marginBottom: 6 }}>
        <h3>Recently recorded</h3>
        <button className="btn ghost sm" onClick={onSeeAll} style={{ gap: 4 }}>
          All history <Icon name="arrowRight" size={12} />
        </button>
      </div>
      <div className="holdings-list">
        {recent.map((t) => (
          <EventLine
            key={t.id}
            txn={t}
            realized={realizedByKey.get(`${t.ticker}|${t.tradeDate}`)}
            onOpen={onSeeAll}
          />
        ))}
      </div>
    </div>
  );
}
