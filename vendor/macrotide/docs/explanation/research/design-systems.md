# Design systems: consistency & human/AI foolproofing — a prior-art survey

*Researched June 2026*

## Summary

How teams in 2025–2026 keep a UI design system consistent — and keep **both human
developers and AI coding agents** on-system — for a stack like Macrotide's: an
in-house component library on **vanilla CSS custom-property tokens** (no Tailwind,
no third-party kit), Next.js / React / TypeScript, Biome + GitHub Actions.

The throughline across every credible source: **documentation alone does not
enforce.** A design-system rules file (AGENTS.md / llms.txt / a docs page) yields
roughly **25–40% agent compliance on its own; deterministic gates plus live
component querying reach ~95%.** Prose *routes* a contributor and sets intent;
conformance comes from machine-checkable gates — lint rules, type constraints,
CI checks, and an agent-queryable component manifest. The same gates that stop a
hurried human from pasting a raw hex are what stop an agent from inventing a class
that already exists (exactly the failure that produced a fictional `.evline`
family while drafting [the design-system reference](../../reference/design-system.md)).

## Decision

Macrotide treats the **token layer as the contract** and moves foolproofing from
prose to **deterministic gates**, sequenced so the cheap mechanical wins land first
and the heavier rebuilds are independent. The actionable, tiered roadmap is tracked
as a single backlog epic on the [project board](https://github.com/users/Sitthinut/projects/2)
(linked from [the design-system reference](../../reference/design-system.md)); this
survey is the evidence behind it. One open architectural choice — author tokens in
DTCG JSON and *generate* `globals.css`, vs. keep `globals.css` canonical — is logged
as a decision in [decisions/](../decisions/), since it gates the token-enforcement
and typed-API work.

## The core finding: gates beat prose

Static context (a rules file, a style guide, an llms.txt) is **necessary but not
sufficient**. The repeatedly reported ceiling is ~25–40% compliance from guidance
alone; teams that reach ~95% add runtime enforcement — lint/CI gates and an agent
that *queries the live library* at generation time instead of guessing
([0xfauzi, agent-rules best practices](https://gist.github.com/0xfauzi/7c8f65572930a21efa62623557d83f6e),
late 2025). For an off-the-golden-path stack (vanilla CSS + in-house components),
the turnkey AI tools (v0, shadcn MCP) don't fit — v0 is "specifically trained on
the default implementations of shadcn/ui and may struggle with customizations"
([v0 docs](https://v0.app/docs/design-systems)) — so the gates must live in-repo.
That is not a loss: the in-repo deterministic gates are the highest-ROI items
regardless.

## Design tokens

**Three tiers — primitive → semantic → component.** Primitives name appearance
(`--red-500`, `--space-4`); semantic tokens name intent (`--color-bg-surface`,
`--color-text-muted`) and are the *only* layer components consume; component tokens
exist for per-component overrides. Re-theming then re-points the semantic→primitive
map in one place instead of find-replacing raw values
([goodpractices.design](https://goodpractices.design/articles/design-tokens),
[Contentful](https://www.contentful.com/blog/design-token-system/)).

**What changed recently:** the **W3C DTCG design-tokens format reached its first
*stable* version, 2025.10, on 28 Oct 2025** — JSON tokens with `$value`/`$type`,
`{path}` aliases, standardized light/dark + multi-brand theming and modern color
spaces (oklch, P3)
([W3C announcement](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/)).
The implied best practice: author tokens once in `*.tokens.json`, **generate** the
CSS custom properties *and* a typed export, so CSS and machine-readable form cannot
drift. Tooling: **Style Dictionary v4** (mature DTCG support; full 2025.10 lands in
v5) or **Terrazzo** (most spec-complete)
([Style Dictionary DTCG](https://styledictionary.com/info/dtcg/),
[Terrazzo](https://terrazzo.app/docs/)).

**Nearly-free CSS wins now Baseline:** `:root { color-scheme: light dark }` plus
`light-dark(lightVal, darkVal)` collapses duplicated light/dark token blocks into
single-line semantic tokens (Baseline since May 2024;
[MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark)). A
`[data-theme]` override flips `color-scheme` for a manual toggle. Define the palette
in **oklch** (perceptually uniform) and derive tints/states with `color-mix(in
oklch, …)` and relative-color syntax to roughly halve token count
([Modern CSS Tools](https://moderncsstools.com/guides/modern-colors/)).

**Contrast as a token-layer check.** Validate semantic token *pairings*
(text-on-surface, muted-on-bg, on-primary — and the same in dark) in CI, not just
per page. WCAG 2.2 ratios remain the referenced standard in 2025–26; APCA (headed
for WCAG 3) is a complementary dark-mode check, not yet a replacement
([66colorful, APCA vs WCAG](https://66colorful.com/blog/apca-contrast/)).

## Component libraries

**Typed variant APIs make wrong variants un-compilable.** `class-variance-authority`
(cva) is **class-name-agnostic — it works without Tailwind**: declare base + named
variant groups + compound/default variants, and `VariantProps<typeof x>` infers the
prop types. It can simply *select* existing vanilla CSS classes (`.btn`,
`.btn--primary`) by variant, turning "button-via-CSS-classes" into a typed API with
zero CSS rewrite ([cva docs](https://cva.style/docs)).

**Discriminated unions make invalid UI unrepresentable.** A shared literal
discriminant lets TypeScript forbid bad combinations — an icon button *requires*
`aria-label` and *forbids* `children`; a non-dismissible modal can't take `onClose`.
"Bugs become impossible to write"
([oneuptime, Jan 2026](https://oneuptime.com/blog/post/2026-01-15-typescript-discriminated-unions-react-props/view)).

**Don't hand-roll accessible behavior — build the skin over a headless base.**
Focus trap, scroll-lock, `aria-modal`, ESC/return-focus are the high-risk parts of
a custom Modal. **Base UI v1.0 shipped Dec 2025** (from the Radix/Floating-UI team,
the actively-maintained Radix successor); **React Aria** (Adobe) is the deepest
a11y option. Apply vanilla-token CSS to their unstyled parts
([InfoQ, Base UI v1](https://www.infoq.com/news/2026/02/baseui-v1-accessible/),
[React Aria](https://react-spectrum.adobe.com/react-aria/why.html)).

**Ship a small primitive set, resist sprawl.** `Box`/`Stack`/`Grid`/`Text` with
*token-only* props (`<Stack gap="100">` → `var(--space-100)`; a raw `gap="13px"`
won't compile) absorb most layout/typography and kill the reach for inline `style`
([Atlassian primitives](https://atlassian.design/components/primitives/overview)).
The **shadcn/ui model** — components copied into your repo, you own the source, no
dependency lock-in — is the reference for in-house systems; its **registry** concept
(2025) distributes components, tokens, lint rules, and codemods as installable units
([ui.shadcn.com/docs/registry](https://ui.shadcn.com/docs/registry)).

## Human-side enforcement

**Biome can't gate tokens — this is the key gap.** Biome's `noHexColors` is
nursery-only and `noMagicNumbers` is JS-only/off-by-default; neither forces
`var(--token)` for CSS properties ([Biome CSS rules](https://biomejs.dev/linter/css/rules/)).
The standard complement is **Stylelint + `stylelint-declaration-strict-value`**, run
*alongside* Biome (formatting off; Biome keeps formatting): require a `var()` for
`color`/`background`/`border`/`fill`/`box-shadow` **and** spacing/radius/font-size,
so a raw hex or magic px fails CI
([AndyOGo/stylelint-declaration-strict-value](https://github.com/AndyOGo/stylelint-declaration-strict-value),
[Bar Shaya, token enforcement](https://medium.com/@barshaya97_76274/design-tokens-enforcement-977310b2788e)).

**Drift detection without enterprise tooling.** `ui-drift` (free, AST-based) scores a
React/TS repo 0–100 on DS-adoption %, hardcoded color/spacing counts, and duplicate
Button/Card families, with JSON output for CI
([pcabel85/ui-drift](https://github.com/pcabel85/ui-drift)). A grep ratio of
`var(--token)` vs raw literals is the 80% substitute.

**Component contract + visual/a11y gates (heavier).** Storybook remains the standard
catalog — **Storybook 9 (Jun 2025)** added Vitest+Playwright component testing and an
axe-core a11y addon; **Storybook 10 (Nov 2025)** is ESM-only with Next.js 16 support
([Storybook 9](https://storybook.js.org/blog/storybook-9/)). Visual regression via
Chromatic (component-level) or Playwright `toHaveScreenshot` (pin baselines to the CI
image to avoid Mac↔Linux drift). Page a11y via `@axe-core/playwright`, gating
critical violations on PRs. **Pre-commit catches fast/local; CI re-enforces as
required status checks** — hooks are bypassable, so CI is authoritative.

## AI-agent guardrails

**Machine-readable specs.** Google Labs' **`DESIGN.md`** (Apache-2.0; alpha; pushed
Apr 2026) = YAML tokens + prose rationale, with a CLI that is the load-bearing part:
`lint` (broken refs + WCAG contrast), `diff` (fail CI on token drift), `export`
(→ CSS / Tailwind / DTCG), `spec` (dump for prompt injection)
([github.com/google-labs-code/design.md](https://github.com/google-labs-code/design.md)).
The format is "a better-structured CLAUDE.md design section"; the CLIs are the real,
deterministic value.

**MCP over the component library is the structural fix for "reinvents instead of
reuses."** The agent queries the *live* library at generation time. The **shadcn MCP**
(Aug 2025) and **Storybook MCP** (Dec 2025) return prop types + validated usage
examples "in a fraction of the tokens" of reading source
([Storybook MCP](https://tympanus.net/codrops/2025/12/09/supercharge-your-design-system-with-llms-and-storybook-mcp/)).
A ~100-line stdio MCP reading a repo's component `.d.ts` + curated examples gets most
of the value for an in-house library.

**Rules files: necessary, not sufficient — and consolidating.** **AGENTS.md** is the
emerging cross-tool standard (OpenAI Aug 2025 → donated to the Linux Foundation's
Agentic AI Foundation Dec 2025; 60k+ repos), though **Claude Code reads CLAUDE.md**
(the one-line `@`-import of AGENTS.md that this repo already uses is the right
bridge). What works: copy-pasteable file-scoped commands over prose, ~150-line cap,
nested per-directory files, link don't duplicate, good/anti-pattern examples by path
([codersera, AGENTS vs CLAUDE 2026](https://codersera.com/blog/agents-md-vs-claude-md-vs-cursor-rules-comparison-2026/)).
**llms.txt** is a docs *router* for coding assistants, not an enforcement mechanism
([Mintlify](https://www.mintlify.com/blog/what-is-llms-txt)).

**Verification loops close the gap.** The pattern that reaches high compliance:
generate → run scoped lint/tests (and "does this component already exist?" checks) →
agent reads failures → self-corrects → human reviews only on green. Macrotide already
has `agent-browser` / Playwright and a `/verify` skill to host this loop.

## Governance for a small team

Lean is the norm, not a compromise — most design-system teams are 2–5 people, and the
risk is *accidental* smallness, not deliberate leanness
([NN/g, May 2026](https://www.nngroup.com/articles/lean-design-system-teams/)).
For a solo/tiny team the "governance" is three cheap things: a **one-page
Definition-of-Done for UI** that gates PRs (uses tokens, reused an existing component,
has loading/empty/error states, WCAG AA, mobile-first, docs in the same PR), a **CI
drift score**, and **docs that travel with code** (Diátaxis incrementally — never
scaffold empty buckets; each component gets a Reference props table *plus* Do's/Don'ts
and "when to use vs its sibling")
([Diátaxis](https://diataxis.fr/how-to-use-diataxis/),
[Design Systems Collective](https://www.designsystemscollective.com/design-system-best-practices-components-and-documentation-bdb020e02172)).
Explicitly overkill: governance committees, RFC/voting, champion programs,
multiplatform token pipelines, 1:1 contributor coaching.

For a finance dashboard specifically, consistency *is* the trust signal: one canonical
way to render currency / gain-loss (sign + color, never color-only) / % / date, and
**progressive disclosure** (lead with one hero number, tuck detail behind drill-down)
to keep the "calm, private-wealth" feel
([Eleken, fintech UX](https://www.eleken.co/blog-posts/fintech-ux-best-practices),
[NN/g, Consistency & Standards](https://www.nngroup.com/articles/consistency-and-standards/)).

## About this research

Gathered June 2026 via five parallel web-research subagents (one per area: tokens,
component APIs, human-side enforcement, AI-agent guardrails, governance/UX), each
running WebSearch + WebFetch and returning dated, source-linked findings synthesized
here. Source URLs are cited inline. Version/date facts checked against primary
sources where possible: **DTCG 2025.10 stable (28 Oct 2025)**, `light-dark()`
**Baseline May 2024**, **Base UI v1.0 (Dec 2025)**, **Storybook 9 (Jun 2025) / 10
(Nov 2025)**, **AGENTS.md → Linux Foundation (Dec 2025)**, Google **`DESIGN.md`**
(alpha, Apr 2026). The headline ~25–40%-vs-~95% compliance figures come from
practitioner write-ups (0xfauzi; Storybook/Figma MCP posts), not a controlled study —
treat as directional. Vendor/promotional sources (Figma, v0, DESIGN.md) were read
skeptically and flagged where claims were unbacked.
