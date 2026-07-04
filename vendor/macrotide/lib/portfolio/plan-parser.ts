// Pure helpers that parse a free-form markdown plan into spine sections +
// extras, and turn bullet/question lists into structured arrays.
// Moved out of lib/mock/data.ts because the helpers themselves are not mock —
// they're called against real user plan markdown loaded from /api/plan.

export interface ParsedPlan {
  spine: {
    target: string | null;
    principles: string | null;
    risk: string | null;
    commitments: string | null;
  };
  extras: { title: string; body: string }[];
}

export function parsePlan(md: string | undefined): ParsedPlan {
  if (!md?.trim()) {
    return {
      spine: { target: null, principles: null, risk: null, commitments: null },
      extras: [],
    };
  }
  const sections: Record<string, string> = {};
  const lines = md.split("\n");
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (current) sections[current.toLowerCase()] = buffer.join("\n").trim();
      current = m[1].trim();
      buffer = [];
    } else if (current) {
      buffer.push(line);
    }
  }
  if (current) sections[current.toLowerCase()] = buffer.join("\n").trim();

  const findSection = (...keys: string[]) => {
    for (const k of keys) {
      const match = Object.keys(sections).find((s) => s.includes(k));
      if (match) return sections[match];
    }
    return null;
  };

  const spine = {
    target: findSection("target", "allocation"),
    principles: findSection("principles", "care about", "values"),
    risk: findSection("risk", "drawdown", "volatility"),
    commitments: findSection("commitment", "decided", "rules"),
  };

  const usedKeys = new Set<string>();
  for (const k of Object.keys(sections)) {
    if (
      k.includes("target") ||
      k.includes("allocation") ||
      k.includes("principles") ||
      k.includes("care about") ||
      k.includes("values") ||
      k.includes("risk") ||
      k.includes("drawdown") ||
      k.includes("volatility") ||
      k.includes("commitment") ||
      k.includes("decided") ||
      k.includes("rules")
    )
      usedKeys.add(k);
  }
  const extras: { title: string; body: string }[] = [];
  for (const k of Object.keys(sections)) {
    if (!usedKeys.has(k)) {
      extras.push({
        title: k.charAt(0).toUpperCase() + k.slice(1),
        body: sections[k],
      });
    }
  }
  return { spine, extras };
}

export function parseCommitments(text: string | null | undefined) {
  if (!text) return [] as { text: string; status: string; i: number }[];
  return text
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((t, i) => ({ text: t, status: "in_progress", i }));
}

export function parseBullets(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

export function parseQuestions(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.endsWith("?"));
}
