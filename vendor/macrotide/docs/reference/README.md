# Reference

Information-oriented lookup material. Dry, accurate, and structured to mirror
the code. Come here to check a fact, not to learn a workflow.

| Reference | Contains |
|---|---|
| [Configuration](./configuration.md) | How configuration is loaded + the canonical env-var table |
| [Auth & AI providers](./auth-and-providers.md) | Passkeys, OpenRouter, rate limits, where data lives |
| [API routes](./api.md) | Every `app/api/*` route handler, grouped by domain |
| [Data model](./data-model.md) | The SQLite tables, key columns, and relationships |
| [Design system](./design-system.md) | The real CSS tokens, high-reuse classes, and shared UI components for building matching UI |

A few facts are single-sourced elsewhere and linked rather than copied:

| Topic | Canonical location |
|---|---|
| Environment variables | [configuration.md § Environment variables](./configuration.md#environment-variables) |
| Security / threat model | [SECURITY.md](../../SECURITY.md) (repo root) |
| Deployment steps | [how-to/deploy.md](../how-to/deploy.md) |

For the *why* behind these facts, see [explanation](../explanation).
