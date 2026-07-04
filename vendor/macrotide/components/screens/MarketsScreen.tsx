"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { ManageIndicatorsSheet } from "@/components/ManageIndicatorsSheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import {
  type MarketIndexResponse,
  type MarketNewsItem,
  useMarketIndices,
  useMarketNews,
} from "@/lib/fetchers/portfolio";
import { fmtRelativeDate } from "@/lib/format";
import { indicatorBySymbol } from "@/lib/market/indicators";
import { LEARN_CONTENT } from "@/lib/static/learn";
import type { LearnArticle, MarketIndex } from "@/lib/static/types";

export interface MarketsScreenProps {
  onOpenSettings: () => void;
  /** Show the top-right kebab that opens the account menu (mobile only). */
  showMenu?: boolean;
}

export function MarketsScreen({ onOpenSettings, showMenu = true }: MarketsScreenProps) {
  const [tab, setTab] = useState<"today" | "learn">("today");
  return (
    <div className="screen">
      <div className="topbar">
        <div className="brand" style={{ flex: 1 }}>
          <span>Markets</span>
        </div>
        {showMenu && (
          <button className="icon-btn" aria-label="More" onClick={onOpenSettings}>
            <Icon name="ellipsis-vertical" size={13} />
          </button>
        )}
      </div>

      <div className="sub-tabs">
        <button data-active={tab === "today"} onClick={() => setTab("today")}>
          Today
        </button>
        <button data-active={tab === "learn"} onClick={() => setTab("learn")}>
          Learn
        </button>
      </div>

      {tab === "today" && <MarketsToday />}
      {tab === "learn" && <MarketsLearn />}
    </div>
  );
}

function adaptIndices(rows: MarketIndexResponse[]): {
  indices: MarketIndex[];
  failures: number;
  asOf: string | null;
} {
  let failures = 0;
  let asOf: string | null = null;
  const indices: MarketIndex[] = [];
  for (const r of rows) {
    if (!r.ok || r.price == null) {
      failures++;
      continue;
    }
    if (r.asOf && (!asOf || r.asOf > asOf)) asOf = r.asOf;
    indices.push({
      sym: r.label,
      name: r.name,
      val: r.price,
      d: r.d1Pct ?? 0,
      isYield: indicatorBySymbol(r.symbol)?.isYield ?? false,
    });
  }
  return { indices, failures, asOf };
}

function MarketsToday() {
  const { data: liveRows, isLoading } = useMarketIndices();
  const live = useMemo(() => (liveRows ? adaptIndices(liveRows) : null), [liveRows]);
  const [manageOpen, setManageOpen] = useState(false);

  // Only ever show real, fetched index values — never fabricated mock numbers.
  // When nothing loads we render an honest unavailable state instead.
  const indices = live?.indices ?? [];
  const asOf = indices.length > 0 ? (live?.asOf ?? null) : null;

  return (
    <>
      <MarketsTodayInner
        indices={indices}
        asOf={asOf}
        loading={isLoading && !liveRows}
        onManage={() => setManageOpen(true)}
      />
      <ManageIndicatorsSheet open={manageOpen} onClose={() => setManageOpen(false)} />
    </>
  );
}

function MarketsTodayInner({
  indices,
  asOf,
  loading,
  onManage,
}: {
  indices: MarketIndex[];
  asOf: string | null;
  loading: boolean;
  onManage: () => void;
}) {
  return (
    <div>
      {/* The AI-written "Today, in your words" digest is intentionally absent
          until it's generated from real data. We don't ship a static digest
          with fabricated portfolio figures. */}
      <div className="section" style={{ marginTop: 0 }}>
        <div className="section-header">
          <h3>Indices</h3>
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {asOf && (
              <span className="link" style={{ color: "var(--muted)" }}>
                as of {fmtRelativeDate(asOf)}
              </span>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label="Manage indicators"
              onClick={onManage}
            >
              <Icon name="settings" size={14} />
            </button>
          </span>
        </div>
        {indices.length > 0 ? (
          <div className="card" style={{ padding: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
              {indices.map((idx, i) => (
                <div
                  key={idx.sym}
                  style={{
                    padding: 12,
                    borderRight: i % 2 === 0 ? "1px solid var(--line-soft)" : "none",
                    borderBottom: i < indices.length - 2 ? "1px solid var(--line-soft)" : "none",
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--muted)",
                      fontFamily: "var(--font-mono)",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {idx.sym}
                  </div>
                  <div className="num" style={{ fontSize: 16, marginTop: 3, fontWeight: 500 }}>
                    {idx.val.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                    {idx.isYield ? "%" : ""}
                  </div>
                  <div
                    className={`delta ${idx.d >= 0 ? "up" : "down"}`}
                    style={{ fontSize: 11, marginTop: 1 }}
                  >
                    {idx.d >= 0 ? "▲" : "▼"} {Math.abs(idx.d).toFixed(2)}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : loading ? (
          <div className="card" style={{ padding: 14 }}>
            <SkeletonRows rows={4} height={44} gap={10} padding={0} />
          </div>
        ) : (
          <div
            className="card"
            style={{
              padding: "18px 16px",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
            }}
          >
            Market data is unavailable right now.
          </div>
        )}
      </div>

      <MarketsNewsSection />
    </div>
  );
}

function MarketsNewsSection() {
  const { data, isLoading, error } = useMarketNews();
  const items = data?.items ?? [];
  const allFailed = !isLoading && (error != null || (data != null && items.length === 0));

  return (
    <div className="section">
      <div className="section-header">
        <h3>From the long-term investing desk</h3>
        <span className="link" style={{ color: "var(--muted)" }}>
          {data?.failures ? `${data.failures} source${data.failures > 1 ? "s" : ""} down` : ""}
        </span>
      </div>
      <div className="card" style={{ padding: "4px 14px" }}>
        {isLoading && <SkeletonRows rows={3} height={34} gap={10} padding="12px 0" />}
        {!isLoading && allFailed && (
          <div
            style={{
              padding: 12,
              fontSize: 12,
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.02em",
            }}
          >
            News sources are temporarily unreachable. Try again in a few minutes.
          </div>
        )}
        {!isLoading && !allFailed && items.map((n) => <NewsRow key={n.id} item={n} />)}
      </div>
    </div>
  );
}

function NewsRow({ item }: { item: MarketNewsItem }) {
  const relative = relativeTime(item.publishedAt);
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="news-card"
      style={{ display: "block", color: "inherit", textDecoration: "none" }}
    >
      <div className="head">
        <span>
          {item.source}
          {relative ? ` · ${relative}` : ""}
        </span>
      </div>
      <div className="title">{item.title}</div>
    </a>
  );
}

function relativeTime(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}

function MarketsLearn() {
  const L = LEARN_CONTENT;
  const saveArticle = (a: LearnArticle) =>
    window.dispatchEvent(new CustomEvent("save-reading", { detail: a }));

  return (
    <div>
      <div className="section" style={{ marginTop: 0 }}>
        <div className="section-header">
          <h3>Start here</h3>
          <span className="link">Foundations</span>
        </div>
        {L.startHere.map((a) => (
          <div key={a.id} className="article-card" onClick={() => saveArticle(a)}>
            <div className="meta-row">
              <span>{a.tag}</span>
              <span>· {a.readTime} MIN READ</span>
              <span style={{ marginLeft: "auto", color: "var(--accent-ink)" }}>📑 SAVE</span>
            </div>
            <div className="a-title">{a.title}</div>
            <div className="a-blurb">{a.blurb}</div>
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-header">
          <h3>Recommended for you</h3>
          <span className="link" style={{ color: "var(--accent-ink)" }}>
            ● Based on your portfolio
          </span>
        </div>
        {L.recommendedForYou.map((a) => (
          <div
            key={a.id}
            className="article-card"
            style={{ background: "var(--accent-soft)", borderColor: "transparent" }}
            onClick={() => saveArticle(a)}
          >
            <div className="meta-row" style={{ color: "var(--accent-ink)", opacity: 0.7 }}>
              <span>{a.tag}</span>
              <span>· {a.readTime} MIN READ</span>
              <span style={{ marginLeft: "auto" }}>📑 SAVE</span>
            </div>
            <div className="a-title" style={{ color: "var(--accent-ink)" }}>
              {a.title}
            </div>
            <div className="a-blurb" style={{ color: "var(--accent-ink)", opacity: 0.85 }}>
              {a.blurb}
            </div>
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-header">
          <h3>By topic</h3>
        </div>
        <div className="filter-chips" style={{ padding: "0 4px" }}>
          {L.topics.map((t) => (
            <span key={t.id} className="chip" data-static>
              {t.label} <span style={{ color: "var(--muted)", marginLeft: 4 }}>{t.count}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="card" style={{ padding: 14, textAlign: "center" }}>
          <Icon name="sparkle" size={20} />
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              marginTop: 6,
              marginBottom: 4,
              letterSpacing: "-0.01em",
            }}
          >
            Found something elsewhere?
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--muted)",
              lineHeight: 1.45,
              marginBottom: 12,
            }}
          >
            Paste a link in chat and ask the advisor to read it. It&apos;ll save the summary to your
            Journal.
          </div>
          <button
            className="btn ghost sm"
            onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "chat" }))}
          >
            <Icon name="chat" size={12} /> Send a link to the advisor
          </button>
        </div>
      </div>
    </div>
  );
}
