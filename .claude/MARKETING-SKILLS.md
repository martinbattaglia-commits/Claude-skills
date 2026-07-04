# Marketing Skills (vendored)

Project-scoped install of **[marketingskills](https://github.com/coreyhaines31/marketingskills)**
by [Corey Haines](https://corey.co) — 46 Agent Skills for CRO, copywriting, SEO,
paid ads, ad creative, prospecting, lifecycle, and growth.

| | |
|---|---|
| Source | https://github.com/coreyhaines31/marketingskills |
| Version | 2.6.0 |
| Upstream commit | `30dbd7f793b86f0ec2f007757b333afac93c24db` |
| License | MIT — see [`LICENSE-marketing-skills`](./LICENSE-marketing-skills) |

## Layout

```
.claude/
  skills/   # 46 marketing skills (auto-discovered by Claude Code in this project)
  tools/    # CLI wrappers + integration docs the skills reference via ../../tools/
```

These are installed under `.claude/` so they are **project-scoped** and kept fully
separate from this repo's own `skills/seo-*` product skills (no collision — the
upstream `seo-audit` skill lives at `.claude/skills/seo-audit/`, distinct from the
repo's `skills/seo-audit/`).

## Usage

Claude Code auto-discovers `.claude/skills/*` when working in this project. Invoke a
skill by describing the task (e.g. "improve conversions on this landing page" →
`cro`), or reference it directly. The `product-marketing` skill is the foundation —
most skills read `.agents/product-marketing.md` (or `.claude/product-marketing.md`)
first for product/audience/positioning context, so create that file to prime them.

## Updating

Re-copy `skills/` and `tools/` from a newer upstream checkout, or track upstream as
a submodule. See the upstream README for `npx skills` / plugin-marketplace install
options.
