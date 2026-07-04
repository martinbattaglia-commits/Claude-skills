"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ModelDonut } from "@/components/charts";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useModelPortfoliosView } from "@/lib/fetchers/legacy";
import { invalidate } from "@/lib/fetchers/swr";
import { modelPortfolioToInsert } from "@/lib/portfolio/adapter";
import type { ModelPortfolio } from "@/lib/static/types";
import { onActivate } from "@/lib/ui-events";

export interface ModelPortfoliosScreenProps {
  selectedId: string;
  onSelect: (id: string) => void;
  onBack: () => void;
}

export function ModelPortfoliosScreen({
  selectedId,
  onSelect,
  onBack,
}: ModelPortfoliosScreenProps) {
  const { models, isLoading, error } = useModelPortfoliosView();
  const [openId, setOpenId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "curated" | "custom">("all");

  const list = models ?? [];
  const open = list.find((m) => m.id === openId);

  const filtered =
    filter === "custom"
      ? list.filter((m) => m.isCustom)
      : filter === "curated"
        ? list.filter((m) => !m.isCustom)
        : list;

  // Duplicate-to-customize: fork a (built-in or any) model into a user-owned,
  // editable copy. The POST path stamps the current user via ownerId(), so the
  // copy is `built_in = false` and fully editable, while the shared original is
  // never mutated. Opens the new copy so the user can immediately edit it.
  const duplicateModel = async (m: ModelPortfolio) => {
    try {
      const copy: ModelPortfolio = {
        ...m,
        id: `custom_${Date.now()}`,
        name: `${m.name} (copy)`,
        isCustom: true,
      };
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(modelPortfolioToInsert(copy)),
      });
      const saved = res.ok ? await res.json() : null;
      await invalidate("/api/models");
      setOpenId(saved?.id ?? copy.id);
    } catch (err) {
      console.error("Failed to duplicate model:", err);
    }
  };

  const deleteModel = async (id: string) => {
    try {
      await fetch(`/api/models/${id}`, { method: "DELETE" });
      await invalidate("/api/models");
      setOpenId(null);
    } catch (err) {
      console.error("Failed to delete model:", err);
    }
  };

  if (open) {
    return (
      <ModelDetail
        model={open}
        selected={selectedId === open.id}
        onBack={() => setOpenId(null)}
        onSelect={onSelect}
        onDuplicate={() => duplicateModel(open)}
        onDelete={() => deleteModel(open.id)}
      />
    );
  }

  // Check error FIRST: the view's isLoading is `!data`, so a failed fetch
  // would otherwise show the skeleton forever instead of saying anything.
  if (error && !models) {
    return (
      <div className="screen">
        <div className="topbar">
          <div className="brand" style={{ flex: 1 }}>
            <span>Templates</span>
          </div>
        </div>
        <div style={{ padding: "0 14px" }}>
          <div className="card" style={{ fontSize: 12.5, color: "var(--loss)", padding: 14 }}>
            Failed to load templates. Check your connection and reload.
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="screen">
        <div className="topbar">
          <div className="brand" style={{ flex: 1 }}>
            <span>Templates</span>
          </div>
        </div>
        <SkeletonRows rows={3} height={88} padding="14px 16px" />
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back" style={{ marginRight: 8 }}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="brand" style={{ flex: 1 }}>
          <span>Templates</span>
        </div>
        <button
          className="icon-btn"
          aria-label="Add custom"
          onClick={() => setAddOpen(true)}
          style={{ borderColor: "var(--accent)" }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div style={{ padding: "4px 20px 14px" }}>
        <p
          style={{
            fontSize: 13.5,
            color: "var(--ink-soft)",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          Time-tested index-investing strategies. Pick one as your{" "}
          <strong style={{ fontWeight: 500 }}>target allocation</strong>, duplicate one to make it
          yours, or design your own with the advisor.
        </p>
      </div>

      <div className="filter-chips" style={{ padding: "0 16px 12px" }}>
        <button
          type="button"
          className="chip"
          data-active={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All · {list.length}
        </button>
        <button
          type="button"
          className="chip"
          data-active={filter === "curated"}
          onClick={() => setFilter("curated")}
        >
          Curated · {list.filter((m) => !m.isCustom).length}
        </button>
        <button
          type="button"
          className="chip"
          data-active={filter === "custom"}
          onClick={() => setFilter("custom")}
        >
          Yours · {list.filter((m) => m.isCustom).length}
        </button>
      </div>

      <div
        style={{
          padding: "0 14px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {filtered.map((m) => (
          <div
            key={m.id}
            className="card"
            style={{
              cursor: "pointer",
              borderColor: selectedId === m.id ? "var(--accent)" : "var(--line-soft)",
              borderWidth: selectedId === m.id ? 2 : 1,
              padding: 14,
            }}
            {...onActivate(() => setOpenId(m.id))}
          >
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <ModelDonut mix={m.mix} size={56} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14.5,
                    fontWeight: 500,
                    letterSpacing: "-0.01em",
                    lineHeight: 1.25,
                    marginBottom: 4,
                  }}
                >
                  {m.name}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginBottom: 6,
                    flexWrap: "wrap",
                  }}
                >
                  {selectedId === m.id && (
                    <span className="tag green" style={{ fontSize: 9 }}>
                      ● TARGET
                    </span>
                  )}
                  {m.isCustom && (
                    <span
                      className="tag"
                      style={{
                        fontSize: 9,
                        background: "var(--card-soft)",
                      }}
                    >
                      CUSTOM
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--muted)",
                    lineHeight: 1.35,
                    marginBottom: 8,
                  }}
                >
                  {m.tagline}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    fontSize: 11,
                    color: "var(--ink-soft)",
                    flexWrap: "wrap",
                  }}
                >
                  <span className="num">
                    <span style={{ color: "var(--muted)" }}>Return</span>{" "}
                    {m.expectedReturn.toFixed(1)}%
                  </span>
                  <span className="num">
                    <span style={{ color: "var(--muted)" }}>Vol</span> {m.expectedVol.toFixed(1)}%
                  </span>
                  <span className="num">
                    <span style={{ color: "var(--muted)" }}>TER</span> {m.ter.toFixed(2)}%
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}

        <div
          className="card"
          style={{
            padding: 14,
            cursor: "pointer",
            borderStyle: "dashed",
            borderColor: "var(--line)",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
          {...onActivate(() => setAddOpen(true))}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 11,
              background: "var(--card-soft)",
              display: "grid",
              placeItems: "center",
              color: "var(--accent)",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                letterSpacing: "-0.01em",
              }}
            >
              Add custom template
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              From URL, image, text, or chat
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div
          style={{
            fontSize: 11,
            color: "var(--muted)",
            lineHeight: 1.5,
            padding: "0 4px",
            fontFamily: "var(--font-mono)",
          }}
        >
          ⓘ Expected return/vol are historical estimates, not guarantees. Past performance does not
          predict future results.
        </div>
      </div>

      <AddCustomModelSheet open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function ModelDetail({
  model,
  selected,
  onBack,
  onSelect,
  onDuplicate,
  onDelete,
}: {
  model: ModelPortfolio;
  selected: boolean;
  onBack: () => void;
  onSelect: (id: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  // Built-ins are a shared, read-only library — you fork them to customize.
  // User-owned ("custom") models are editable/deletable in place.
  const isCustom = model.isCustom === true;
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back" style={{ marginRight: 8 }}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="brand" style={{ flex: 1 }}>
          <span>{model.name}</span>
        </div>
      </div>

      <div style={{ padding: "4px 20px 8px" }}>
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>{model.tagline}</div>
        <p
          style={{
            fontSize: 14,
            color: "var(--ink-soft)",
            lineHeight: 1.5,
            margin: "8px 0 0",
          }}
        >
          {model.blurb}
        </p>
      </div>

      <div className="section" style={{ marginTop: 14 }}>
        <div className="card">
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <ModelDonut mix={model.mix} size={92} thickness={14} />
            <div style={{ flex: 1 }}>
              {model.mix.map((m) => (
                <div
                  key={m.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 5,
                    fontSize: 12.5,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: m.color,
                    }}
                  ></span>
                  <span style={{ flex: 1, fontWeight: 500 }}>{m.label}</span>
                  <span className="num" style={{ color: "var(--muted)" }}>
                    {m.pct.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
          }}
        >
          {[
            {
              lbl: "EXPECTED RETURN",
              val: `${model.expectedReturn.toFixed(1)}%`,
              color: "var(--gain)",
            },
            {
              lbl: "VOLATILITY",
              val: `${model.expectedVol.toFixed(1)}%`,
              color: "var(--ink)",
            },
            {
              lbl: "BLENDED TER",
              val: `${model.ter.toFixed(2)}%`,
              color: "var(--ink)",
            },
          ].map((s) => (
            <div
              key={s.lbl}
              className="card-soft"
              style={{ padding: "10px 12px", textAlign: "left" }}
            >
              <div
                style={{
                  fontSize: 9.5,
                  fontFamily: "var(--font-mono)",
                  color: "var(--muted)",
                  letterSpacing: "0.04em",
                  marginBottom: 2,
                }}
              >
                {s.lbl}
              </div>
              <div className="num" style={{ fontSize: 16, fontWeight: 500, color: s.color }}>
                {s.val}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="card">
          <div style={{ display: "flex", gap: 16, fontSize: 12.5, marginBottom: 12 }}>
            <div>
              <div
                style={{
                  color: "var(--muted)",
                  fontSize: 10.5,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.04em",
                  marginBottom: 2,
                }}
              >
                HORIZON
              </div>
              <div style={{ fontWeight: 500 }}>{model.horizon}</div>
            </div>
            <div>
              <div
                style={{
                  color: "var(--muted)",
                  fontSize: 10.5,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.04em",
                  marginBottom: 2,
                }}
              >
                RISK
              </div>
              <div style={{ fontWeight: 500, textTransform: "capitalize" }}>{model.risk}</div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 14,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: "var(--gain)",
                  marginBottom: 6,
                }}
              >
                Pros
              </div>
              {model.pros.map((p) => (
                <div
                  key={p}
                  style={{
                    fontSize: 12,
                    lineHeight: 1.4,
                    marginBottom: 4,
                    color: "var(--ink-soft)",
                  }}
                >
                  + {p}
                </div>
              ))}
            </div>
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: "var(--loss)",
                  marginBottom: 6,
                }}
              >
                Cons
              </div>
              {model.cons.map((c) => (
                <div
                  key={c}
                  style={{
                    fontSize: 12,
                    lineHeight: 1.4,
                    marginBottom: 4,
                    color: "var(--ink-soft)",
                  }}
                >
                  − {c}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="section" style={{ marginTop: 4 }}>
        <button
          className="btn primary full"
          onClick={() => {
            onSelect(model.id);
            onBack();
          }}
          disabled={selected}
        >
          {selected ? "● Currently your target" : "Set as my target allocation"}
          {!selected && <Icon name="arrowRight" size={13} />}
        </button>
        {!isCustom && (
          <button className="btn ghost full" style={{ marginTop: 8 }} onClick={onDuplicate}>
            <Icon name="copy" size={13} /> Duplicate to customize
          </button>
        )}
        {isCustom && (
          <button
            className="btn ghost full"
            style={{ marginTop: 8, color: "var(--loss)" }}
            onClick={() => setConfirmDelete(true)}
          >
            <Icon name="trash" size={13} /> Delete this template
          </button>
        )}
        <button
          className="btn ghost full"
          style={{ marginTop: 8 }}
          onClick={() => {
            window.dispatchEvent(new CustomEvent("nav", { detail: "chat" }));
            const prompt = `Tell me more about the ${model.name} strategy — when does it work best and when does it struggle?`;
            window.dispatchEvent(
              new CustomEvent("ai-prompt", {
                detail: {
                  display: prompt,
                  send: prompt,
                  context: { screen: "models", intent: "strategy_explain", subject: model.name },
                },
              }),
            );
          }}
        >
          <Icon name="chat" size={13} /> Ask the advisor about this
        </button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete template?"
        message={`Permanently delete "${model.name}". This can't be undone.`}
        confirmLabel="Delete template"
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function AddCustomModelSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  // The one real path: hand off to the Advisor, which asks a few questions and
  // proposes an allocation (propose_plan_edit cards) the user can apply to
  // their plan. The former URL/Text/Image methods were setTimeout stubs that
  // returned a canned mix for any input — removed rather than shipped as fake
  // "AI parsed" UX; real ingestion is tracked as a follow-up issue.
  const startChat = () => {
    window.dispatchEvent(
      new CustomEvent("ai-prompt", {
        detail:
          "Help me design a custom portfolio allocation. Ask me a few questions about what I want and propose an allocation.",
      }),
    );
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} variant="form" labelledBy="acm-title">
      <Modal.Header
        title="Add a custom template"
        subtitle="Design an allocation with the advisor, or duplicate any template and tweak the copy."
        id="acm-title"
      />
      <Modal.Body>
        <div
          className="card"
          style={{
            background: "var(--accent-soft)",
            borderColor: "transparent",
            padding: 14,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              marginBottom: 6,
              color: "var(--accent-ink)",
              letterSpacing: "-0.01em",
            }}
          >
            Build with the advisor
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--accent-ink)",
              lineHeight: 1.5,
              marginBottom: 12,
              opacity: 0.85,
            }}
          >
            The advisor asks a few questions about what you want, proposes an allocation, and can
            apply it to your plan once you confirm.
          </div>
          <button className="btn sm primary" onClick={startChat}>
            <Icon name="chat" size={12} /> Start conversation
          </button>
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--muted)",
            lineHeight: 1.5,
            marginTop: 12,
          }}
        >
          Prefer a starting point? Open any template and choose Duplicate — the copy is yours to
          edit.
        </div>
      </Modal.Body>
    </Modal>
  );
}
