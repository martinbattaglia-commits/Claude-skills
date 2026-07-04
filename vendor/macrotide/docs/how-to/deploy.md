# Deploying Macrotide

Macrotide is a single Next.js process talking to local SQLite files. There's no separate database service, no message broker, no caching layer to operate — the smallest viable deploy is one Linux VM with Caddy in front for TLS.

## Database layout (two files, one volume)

The database is split along a lifecycle boundary into **two** SQLite files, both
auto-created under the same `data/` volume:

- **`data/app.db`** (`DB_PATH`) — the system of record: accounts, buckets,
  holdings, plans, journal, models, chat, preferences, user market indicators.
  Precious. **This is the only file backed up.**
- **`data/market.db`** (`MARKET_DB_PATH`, default `data/market.db`) — regenerable
  market data: fund catalog/fees/performance/portfolio/feeder look-through and
  the NAV/quote cache. Rebuilt from upstream (the SEC crawl + market fetches), so
  it is **excluded from the backup** — a lost market.db is re-crawled, not
  restored.

Both default under `data/`, so the bind-mount + `chown 1000:1000 data` steps
below cover both with no extra config. A fresh deploy creates both files from
their baselines on first boot; ordinary schema additions (e.g. the
`buckets.position` column) are applied automatically by the startup migrations —
no manual step.

If you just want to share the app with people on the public internet, follow the "Single VM" path. If you'd rather keep it on your laptop and tunnel via Tailscale, jump to "Tailnet only".

## Modes at a glance

Two supported modes, both first-class:

- **Mode A — localhost (single user):** `npm install && npm run dev`. SQLite at
  `data/app.db`, backups in `data/backups/`. Auth required by default; set
  `AUTH_DISABLED=1` in `.env.local` to skip the passkey gate for trusted local
  dev. Only `OPENROUTER_API_KEY` is needed beyond that for live AI.
- **Mode B — single-owner self-host:** one Linux VM, Caddy reverse proxy
  (automatic HTTPS), systemd to keep Node alive, SQLite on disk with daily
  backups mirrored off-VM (e.g. Cloudflare R2 via `rclone`). Owner signs in with
  a passkey; visitors can try the demo. To invite family/friends with their own
  accounts, finish the public-launch hardening tracked on the
  [GitHub Project board](https://github.com/users/Sitthinut/projects/2).

The rest of this doc is the full runbook for Mode B. Pick **one** front-door:

- **Docker + Cloudflare Tunnel** (below) — recommended when the host already runs
  Docker and the domain is on Cloudflare. No public inbound ports; TLS terminates
  at Cloudflare's edge; the origin IP stays hidden.
- **Single VM (Ubuntu + Caddy)** — bare Node + systemd + a public A-record. Use
  when you're not on Docker/Cloudflare.
- **Tailnet only (Tailscale Serve)** — private access over your tailnet, no public
  domain.

## Docker + Cloudflare Tunnel (recommended)

Containerized self-host where a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
publishes a subdomain (e.g. `macrotide.example.com`) without opening a single
inbound port. The repo ships `Dockerfile` + `docker-compose.yml`; the container
binds host loopback `127.0.0.1:3100`, and `cloudflared` makes an **outbound**
connection to Cloudflare that routes the public hostname back to it.

Why a subdomain (not a path on the apex): the WebAuthn passkey scope and the
session cookie are bound to the host. A dedicated subdomain keeps macrotide's
auth fully isolated from whatever serves the apex.

**Prerequisites:** Docker Engine + Compose plugin on the host; the domain's DNS
managed in Cloudflare.

### 1. Clone + configure

```sh
sudo mkdir -p /opt/services/macrotide && sudo chown $USER:$USER /opt/services/macrotide
cd /opt/services/macrotide
git clone https://github.com/<your-fork>/macrotide.git .

cp .env.example .env.local
chmod 600 .env.local
```

Edit `.env.local`. For a subdomain deploy the host-specific keys matter:

```sh
PUBLIC_APP_URL=https://macrotide.example.com
# WebAuthn relying-party ID. Defaults to the PUBLIC_APP_URL host, which is what
# you want — the SUBDOMAIN, never the apex. Setting it to `example.com` would
# scope passkeys to the whole domain. Leave unset to inherit, or pin it:
AUTH_RP_ID=macrotide.example.com
AUTH_SECRET=        # fresh: openssl rand -base64 32 — do NOT reuse a dev secret
OPENROUTER_API_KEY=sk-or-...
TRUSTED_TIER_MODELS=openrouter/free,openrouter/auto
# Public-tier chat model (own var, never TRUSTED_TIER_MODELS). Default openrouter/free; point
# at a cheap paid model to lift public-tier quality, bounded by the caps below.
# PUBLIC_TIER_MODELS=google/gemini-2.5-flash
# Public-tier spend caps (checked pre-request, reset UTC midnight). Token cap is
# always on; the cents cost cap is OFF unless set (the right bound for a paid
# public-tier model). MODEL_PRICES feeds the cost estimate — match PUBLIC_TIER_MODELS.
# DAILY_TOKEN_BUDGET_PUBLIC=20000
# DAILY_CENTS_BUDGET_PUBLIC=50
# MODEL_PRICES={"google/gemini-2.5-flash":{"in":0.3,"out":2.5}}
# Separate key so demo traffic never burns the owner quota (hardening item):
DEMO_OPENROUTER_API_KEY=sk-or-...
SEC_API_KEY=...     # same subscription key works in every environment
# Optional crawl extra (uses SEC_API_KEY): adds the dividend-history bulk
# sweep to the nightly catalog crawl (small, ~40 pages).
# SEC_INGEST_DIVIDENDS=1
# Optional, one-shot: legacy v1 FundFactsheet key (a SEPARATE subscription)
# for the AIMC peer-group snapshot (scripts/backfill-aimc-v1.ts). The v1
# portal retires 2026-06-30; not used by the running app or the nightly crawl.
# SEC_V1_API_KEY=...
OWNER_EMAIL=you@actual-email   # must match the passkey account you register
# Real index levels (optional, free-tier). Unset ⇒ the chain falls back to the
# Twelve Data ETF proxy → Yahoo. See reference/auth-and-providers.md.
FMP_API_KEY=...     # REAL US index levels (^GSPC/^NDX/^DJI)
EODHD_API_KEY=...   # REAL global index levels + the Thai SET index
ALPACA_API_KEY_ID=...      # keyed fallback for arbitrary US stocks/ETFs (datacenter-safe)
ALPACA_API_SECRET_KEY=...  # (paired with the key id; free IEX feed, no card/KYC)
OPENFIGI_API_KEY=...       # optional; ticker→FIGI rename anchor for US holdings (works keyless)
```

Cookies stay host-scoped by default (better-auth) — do not configure a
`.example.com` cookie domain, or sessions would leak to the apex.

### 2. Build + run

The container runs as the unprivileged `node` user (**uid 1000**). The SQLite
file lives in a bind-mounted `./data` — create it **owned by uid 1000 first**, so
the container can write. If you skip this, Docker auto-creates `./data` as
`root` on first `up` and the DB silently fails on the first query (the `/login`
page still renders, so the healthcheck won't catch it).

```sh
mkdir -p data && sudo chown 1000:1000 data

docker compose up -d --build
# First boot applies all Drizzle migrations against /app/data/app.db.
docker compose logs -f macrotide          # watch startup
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/login   # 200
```

The image carries the full source tree + node_modules on purpose: migrations are
read from `lib/db/migrations/` at startup, and the fund-catalog job runs the
TypeScript in `scripts/` via `tsx` (step 5).

### 3. Install cloudflared + create the tunnel

```sh
# Cloudflare APT repo (ARM64/amd64 auto-detected)
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# Authenticate (opens a browser link — pick the zone for your domain)
cloudflared tunnel login
# Create a named tunnel; this writes a credentials JSON under ~/.cloudflared/
cloudflared tunnel create macrotide
# Map the public hostname to the tunnel (creates a proxied CNAME in Cloudflare DNS)
cloudflared tunnel route dns macrotide macrotide.example.com
```

### 4. Tunnel config + run as a service

```sh
sudo mkdir -p /etc/cloudflared
TUNNEL_ID=$(cloudflared tunnel list --output json | python3 -c 'import sys,json;print([t["id"] for t in json.load(sys.stdin) if t["name"]=="macrotide"][0])')
sudo cp ~/.cloudflared/${TUNNEL_ID}.json /etc/cloudflared/macrotide.json

sudo tee /etc/cloudflared/config.yml > /dev/null <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/macrotide.json

ingress:
  - hostname: macrotide.example.com
    service: http://127.0.0.1:3100
  - service: http_status:404
EOF

sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared --no-pager
```

Verify end-to-end:

```sh
curl -I https://macrotide.example.com        # HTTP/2 200 from /login, CF + Macrotide headers
# Then open it, sign up, register a passkey — origin = macrotide.example.com.
```

Cloudflare proxies the hostname (orange cloud) and serves the edge cert
automatically; you never touch Let's Encrypt or open 80/443. Keep the host
firewall tailnet-only — the tunnel needs only outbound 443.

### 5. Fund-catalog refresh (containerized)

Run the daily SEC refresh *inside* the container (it shares the DB + env) via a
host timer that invokes `scripts/run-job.sh`, which spins an ephemeral
`docker compose run --rm --no-deps` container so an app redeploy can never
kill an in-flight job:

```sh
sudo tee /etc/systemd/system/macrotide-fund-catalog.service > /dev/null <<'EOF'
[Unit]
Description=Macrotide — fund-catalog refresh (SEC fees)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/bash /opt/services/macrotide/scripts/run-job.sh refresh-fund-catalog
EOF

sudo tee /etc/systemd/system/macrotide-fund-catalog.timer > /dev/null <<'EOF'
[Unit]
Description=Run Macrotide fund-catalog refresh daily at 11:00 UTC

[Timer]
OnCalendar=*-*-* 11:00:00 UTC
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now macrotide-fund-catalog.timer
# First run now (cap with --limit=20 to smoke-test):
bash /opt/services/macrotide/scripts/run-job.sh refresh-fund-catalog --limit=20
```

A full crawl is ~10,000–15,000 SEC calls and completes in ~15–30 min at the
5,000-calls/300-second budget (the provider self-throttles + retries) — well
inside the daily window.

### 6. Backups

The SQLite db + daily snapshots live in `/opt/services/macrotide/data/`
(bind-mounted into the container). Point your existing off-site backup at it —
e.g. add `/opt/services/macrotide/data` to the host's restic/rclone paths.

### 7. Updating

```sh
cd /opt/services/macrotide
git pull
docker compose up -d --build       # rebuild; migrations apply on next boot
```

The remaining sections (owner promotion, legal pages, hardening checklist) below
apply to this path too — just substitute "restart the systemd unit" with
"`docker compose restart macrotide`".

## Single VM (Ubuntu + Caddy)

Tested on Oracle Cloud Ampere (ARM64, 4 vCPU, 24 GB RAM, Ubuntu 24.04) — but any VPS with ≥1 GB RAM and a public IP works.

### 1. Provision the host

```sh
ssh ubuntu@<your-server-ip>
# Update + base packages
sudo apt-get update && sudo apt-get -y full-upgrade
sudo apt-get install -y git build-essential

# Node 24 LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt-get install -y nodejs

# Caddy 2.x — automatic HTTPS via Let's Encrypt
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

### 2. Clone + build

```sh
sudo mkdir -p /opt/macrotide && sudo chown $USER:$USER /opt/macrotide
cd /opt/macrotide
git clone https://github.com/<your-fork>/macrotide.git .
npm ci
npm run build
```

### 3. Configure secrets

```sh
cp .env.example .env.local
chmod 600 .env.local
# Edit .env.local — at minimum:
#   PUBLIC_APP_URL=https://macrotide.yourdomain.com
#   AUTH_SECRET=$(openssl rand -base64 32)
#   OPENROUTER_API_KEY=sk-or-...
#   TRUSTED_TIER_MODELS=openrouter/auto   (comma-separated fallback chain; ids from openrouter.ai/models)
#   # Optional: separate key for demo chat — see reference/auth-and-providers.md.
#   # DEMO_OPENROUTER_API_KEY=sk-or-...
# Auth is required by default; set AUTH_DISABLED=1 only for trusted local dev.
```

Sign up at [openrouter.ai](https://openrouter.ai) and load a few dollars of credit; that's enough for many weeks of personal use.

### 4. systemd unit

```sh
sudo tee /etc/systemd/system/macrotide.service > /dev/null <<'EOF'
[Unit]
Description=Macrotide
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/macrotide
EnvironmentFile=/opt/macrotide/.env.local
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=10

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/macrotide/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now macrotide
sudo systemctl status macrotide --no-pager
```

The app binds to `127.0.0.1:3000`. Caddy fronts it for TLS.

### 5. Caddy + DNS

Point an A record at the server, then:

```sh
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
macrotide.yourdomain.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000

    # Hide server fingerprint
    header -Server

    # Match Next.js asset caching
    @assets path /_next/static/*
    header @assets Cache-Control "public, max-age=31536000, immutable"
}
EOF
sudo systemctl reload caddy
```

Caddy obtains a Let's Encrypt cert on first request. Verify:

```sh
curl -I https://macrotide.yourdomain.com
# HTTP/2 200, with strict-transport-security header from Macrotide
```

### 6. Firewall

```sh
sudo ufw default deny incoming
sudo ufw allow 22/tcp           # SSH
sudo ufw allow 80,443/tcp       # HTTP+HTTPS (for Caddy)
sudo ufw --force enable
```

### 7. Verify the deploy

```sh
# Open https://macrotide.yourdomain.com — should land on /login
# Sign up + register a passkey from your phone
# Click "Try the demo" from incognito → verify isolated session
```

### 8. Promote the owner account

New accounts default to the `public` tier (public-model chain only). After you've signed up and registered a passkey on the live URL — so the account exists — grant *your* account the full model chain:

```sh
# In .env.local, set the email you signed up with:
#   OWNER_EMAIL=you@actual-email
npx -y tsx --env-file=.env.local scripts/backfill-owner.ts
```

This finds your account by `OWNER_EMAIL`, attaches any pre-existing `NULL`-owned data to it, and sets its tier to `trusted`. It's idempotent — safe to re-run, and a no-op if `OWNER_EMAIL` is unset.

> `tsx` is a devDependency, so a production box built with `npm ci --omit=dev` won't have it locally — the `-y` flag above lets `npx` fetch it on demand. Alternatively run this step from a full checkout (with dev deps) pointed at the same `DB_PATH`.

To promote anyone else (family/friends) to `trusted`, update their tier directly — `UPDATE account_tier SET tier='trusted' WHERE user_id=(SELECT id FROM user WHERE email='…')`. The change applies on their next request (tier is read per request, not cached).

### 9. Review the legal pages

`/legal/terms` and `/legal/privacy` ship as plain-language templates with nothing operator-specific baked in. Before sharing the link publicly, set these in `.env.local` (all optional):

```sh
OPERATOR_NAME=Your Name        # who runs this instance; unset → generic wording
CONTACT_EMAIL=you@example.com  # shown as a mailto on both pages; unset → no email
LEGAL_JURISDICTION=Thailand    # governing-law clause; unset → the clause is omitted
```

Then read both pages end-to-end and confirm the disclosures match how *you* run the instance. The "Last updated" date is the `LEGAL_LAST_UPDATED` constant in `lib/legal/config.ts` — bump it whenever you edit the copy. Sign-up consent is an inline notice under the create-account button, not a checkbox.

## Tailnet only (Tailscale Serve)

Don't want to deal with public DNS / certs? Bind Macrotide to loopback and serve over Tailscale:

```sh
# Skip Caddy. Same systemd unit binds to 127.0.0.1:3000.
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
```

The app is now reachable at `https://<machine>.<tailnet>.ts.net` from any tailnet peer. Visitors need Tailscale installed. WebAuthn passkeys still work — `.ts.net` is a valid public origin.

## Backups

`data/app.db` is the single source of truth (everything else is config + code).
`data/market.db` is **regenerable** — re-crawled from the SEC + market sources —
so it is deliberately **left out of the backup**; back up only app.db.

Macrotide's runtime calls `backupIfStale()` on boot, snapshotting **app.db** to `data/backups/app-YYYY-MM-DDTHH-MM-SS.db` daily (keeps 30 days). For off-site backup, point restic / borg / rclone at the app.db snapshots once a day (the `data/backups/` glob already excludes market.db):

```sh
# /etc/cron.d/macrotide-backup
0 4 * * * ubuntu rclone copy /opt/macrotide/data/backups/ b2:macrotide-backups/ --transfers 4
```

## Scheduled jobs (systemd timers)

Macrotide uses **systemd timers** (not in-process cron) for periodic background
work — the pick and its rationale are in the
[decisions log](../explanation/decisions/README.md#picks) ("Background job
scheduling", plus the durable rule on job shape). The VM runs UTC; Bangkok is
UTC+7 with no DST, so UTC times are fixed offsets.

Every job is an idempotent `npm run jobs:*` script (also runnable by hand) that a
timer fires; the app process itself schedules nothing. The roster, in run order:

| Job (`npm run …`) | Script | What | Schedule (UTC) |
|---|---|---|---|
| `jobs:refresh-catalog` | `refresh-fund-catalog.ts` | SEC crawl — lands raw payloads in `sec_raw`, then transforms → fund catalog + fees + AUM | 11:00 daily |
| `jobs:transform-catalog` | `transform-catalog.ts` | Re-derive catalog + fees from already-landed `sec_raw` — API-free, seconds (no SEC key). Run after a classification/derivation change instead of a full re-crawl | on demand (not scheduled) |
| `jobs:refresh-share-classes` | `refresh-share-classes.ts` | Priceable share classes (FK-after catalog) | 11:45 daily |
| `jobs:refresh-market` | `refresh-tracked-market.ts` | **Freshness** — NAV for held positions + indicators (held `market` positions deepened to `max`) | 12:30 daily |
| `jobs:prewarm-nav` | `prewarm-nav.ts` | **Coverage** — NAV/AUM for the *whole* catalog | one-off backfill; optional daily append 02:00 |
| `jobs:prewarm-benchmark` | `prewarm-benchmark.ts` | **Coverage** — total-return benchmark series (`benchmark_tr`) for the curated proxy set | one-off backfill; daily append 23:30 |
| `jobs:refresh-us-securities` | `refresh-us-securities.ts` | US stock/ETF catalog from the Nasdaq directory + a bounded FIGI-identity enrichment (OpenFIGI) + FIGI-detected rename → NAV bridge | 01:30 daily |
| `jobs:refresh-popular` | `refresh-popular.ts` | **Coverage** — warm the derived popular US set (most-actives dollar-volume + demand) so common charts open instantly | 02:30 daily |
| `jobs:close-stale` | `close-stale-sessions.ts` | Session-expiry backstop (real-time path is primary) | optional |

`jobs:refresh-market` (freshness) and `jobs:prewarm-nav` (coverage) are a
deliberate pair: the first keeps *what you track* current on a small daily timer;
the second warms NAV for *every registered fund* so the screener and a cold
fund-detail open read deep history instantly. Keep them distinct — the freshness
job never enumerates the catalog.

The Dockerized box (the recommended path) runs each job as a **one-shot
container**, not `docker exec` into the live app: each `ExecStart` is
`bash /opt/services/macrotide/scripts/run-job.sh <job> [args…]`, which wraps
`docker compose run --rm --no-deps macrotide npx tsx … scripts/<job>.ts`.

Why not `docker exec`: an `exec`'d job runs *inside* the app container, so a
deploy (`docker compose up --build`) recreates that container and **SIGKILLs the
in-flight job** (a mid-crawl deploy once killed three nightly catalog
refreshes). A `run --rm` one-off shares the app's image, `.env.local`, and
`./data` volume but is its own ephemeral container, so an app redeploy leaves it
untouched. The bare-Node units below use the `npx -y tsx` form.

**Job observability.** Every `run-job.sh` run ends with two greppable lines in
the unit's journal — `job-peak-mem: <MB>MB` (cgroup v2 peak for the job
container) and `job-summary: job=<name> exit=<code> duration=<s>s` — so memory
creep shows up in logs long before it becomes an OOM:
`journalctl -u macrotide-fund-catalog | grep job-`. For loud failures, give each
job unit an `OnFailure=macrotide-job-failed@%n.service` drop-in pointing at a
one-shot template that logs at err priority and, when
`/opt/services/macrotide/ops.env` defines `JOB_FAIL_WEBHOOK=<ntfy/webhook URL>`,
POSTs the failing unit name to it.

### Fund-catalog refresh

The SEC publishes fresh fee data after ~10:30 UTC daily. The timer fires at **11:00 UTC** to give a comfortable margin.

A full crawl catalogs ~11,500 profile rows (~9,400 unique funds including inactive ones). Fees and AUM are only fetched for currently-offered (Registered) funds — approximately 2,300 — which produces roughly 10,000–15,000 API calls total. At the 5,000-calls/300-second budget this completes in about 15–30 minutes, well within the daily window before the next SEC refresh cycle. No change to the unit files or timer schedule is needed.

Create the service unit:

```sh
sudo tee /etc/systemd/system/macrotide-fund-catalog.service > /dev/null <<'EOF'
[Unit]
Description=Macrotide — fund-catalog refresh (SEC fees)
After=network.target macrotide.service

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/opt/macrotide
EnvironmentFile=/opt/macrotide/.env.local
ExecStart=npx -y tsx --tsconfig tsconfig.scripts.json scripts/refresh-fund-catalog.ts
StandardOutput=journal
StandardError=journal
EOF
```

Create the timer unit:

```sh
sudo tee /etc/systemd/system/macrotide-fund-catalog.timer > /dev/null <<'EOF'
[Unit]
Description=Run Macrotide fund-catalog refresh daily at 11:00 UTC

[Timer]
OnCalendar=*-*-* 11:00:00 UTC
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
EOF
```

Enable and start the timer:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now macrotide-fund-catalog.timer
# Verify the next trigger:
systemctl list-timers macrotide-fund-catalog.timer
```

To run immediately (e.g. on first deploy or after a schema migration):

```sh
sudo systemctl start macrotide-fund-catalog.service
journalctl -u macrotide-fund-catalog.service -f
```

Use `--limit=N` during initial testing to cap the number of funds processed:

```sh
# Override ExecStart for a one-off test run:
sudo systemd-run --unit=macrotide-catalog-test \
  --property=EnvironmentFile=/opt/macrotide/.env.local \
  --property=WorkingDirectory=/opt/macrotide \
  --uid=ubuntu \
  npx -y tsx --tsconfig tsconfig.scripts.json scripts/refresh-fund-catalog.ts --limit=20
journalctl -u macrotide-catalog-test -f
```

### Share-class refresh

After the catalog refresh, enumerate each fund's priceable share classes into
`fund_share_classes` (`scripts/refresh-share-classes.ts`, the
`npm run jobs:refresh-share-classes` script). It reuses the same SEC enumeration —
no extra API calls — but **must run after the catalog** (it FK-references
`fund_catalog`; classes whose parent isn't catalogued yet are skipped). Schedule
it on its own timer a safe margin after 11:00 UTC (e.g. **11:45 UTC**), or run it
inline after the catalog `ExecStart`:

```sh
sudo tee /etc/systemd/system/macrotide-share-classes.service > /dev/null <<'EOF'
[Unit]
Description=Macrotide — share-class refresh (SEC profiles)
After=network.target macrotide.service macrotide-fund-catalog.service

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/opt/macrotide
EnvironmentFile=/opt/macrotide/.env.local
ExecStart=npx -y tsx --tsconfig tsconfig.scripts.json scripts/refresh-share-classes.ts
StandardOutput=journal
StandardError=journal
EOF

sudo tee /etc/systemd/system/macrotide-share-classes.timer > /dev/null <<'EOF'
[Unit]
Description=Run Macrotide share-class refresh daily at 11:45 UTC

[Timer]
OnCalendar=*-*-* 11:45:00 UTC
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now macrotide-share-classes.timer
```

### Tracked-market NAV refresh (freshness)

Proactively refresh the cached NAV/quote for everything the app *tracks* — every
indicator in the catalog (the `market` chain) plus every distinct held position
(routed by its `quote_source`) — so charts are current on the first view of the
day and the unattended digest has fresh numbers. This is `scripts/refresh-tracked-market.ts`
(`npm run jobs:refresh-market`); it's the same `refreshTrackedMarket` job the
`/api/admin/refresh-market` route invokes, so the route and the timer can't drift.

The Thai SEC publishes the day's NAV after ~17:30 Bangkok (**10:30 UTC**), so the
timer fires at **12:30 UTC** — past the NAV window and clear of the 11:00/11:45
SEC crawl. It's a small job (the indicators dominate; only held Thai funds touch
the SEC), bounded by the 24h cache TTL to ~one fetch per symbol per day.

```sh
sudo tee /etc/systemd/system/macrotide-refresh-market.service > /dev/null <<'EOF'
[Unit]
Description=Macrotide — tracked-market NAV refresh (held + indicators)
After=network.target macrotide.service

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/opt/macrotide
EnvironmentFile=/opt/macrotide/.env.local
ExecStart=npx -y tsx --tsconfig tsconfig.scripts.json scripts/refresh-tracked-market.ts
StandardOutput=journal
StandardError=journal
EOF

sudo tee /etc/systemd/system/macrotide-refresh-market.timer > /dev/null <<'EOF'
[Unit]
Description=Run Macrotide tracked-market NAV refresh daily at 12:30 UTC

[Timer]
OnCalendar=*-*-* 12:30:00 UTC
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now macrotide-refresh-market.timer
```

### All-funds NAV pre-warm (coverage)

Pre-warm the NAV + AUM history cache for the *whole* registered-fund universe so
the screener's price / 1-year-return / size columns and a cold fund-detail open
read deep history instantly instead of paying a per-fund fetch on first view.
This is `scripts/prewarm-nav.ts` (`npm run jobs:prewarm-nav`); it walks every
active share-class `ticker` through the same `getCachedSeries` write-through cache
the on-view path uses. `nav_history` is upsert-only and never time-pruned, so a
backfill only ever adds or corrects rows.

It self-throttles under the SEC 5,000-calls/300s budget. A full `--range=max`
backfill is heavy (tens of thousands of calls across the catalog, tens of
minutes); `--retail-only` skips institutional/insurance classes to cut the volume
sharply, and `--limit=N` caps it for a smoke test.

**One-time backfill** (run by hand after deploy, like the share-class backfill —
start with a small `--limit` to confirm it works, then the full run off-peak):

```sh
# Smoke test (a handful of funds):
npx -y tsx --tsconfig tsconfig.scripts.json scripts/prewarm-nav.ts --limit=20

# Full backfill, retail subset first (Dockerized box: `scripts/run-job.sh prewarm-nav --range=max --retail-only`):
npx -y tsx --tsconfig tsconfig.scripts.json scripts/prewarm-nav.ts --range=max --retail-only
```

**Optional daily append** keeps the latest point fresh for the whole catalog. Use
`--range=1mo` (the depth-aware cache keeps each fund's existing deeper history) and
run it off-peak at **02:00 UTC**, far from the 11:00 crawl:

```sh
sudo tee /etc/systemd/system/macrotide-prewarm-nav.service > /dev/null <<'EOF'
[Unit]
Description=Macrotide — all-funds NAV pre-warm (daily append)
After=network.target macrotide.service

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/opt/macrotide
EnvironmentFile=/opt/macrotide/.env.local
ExecStart=npx -y tsx --tsconfig tsconfig.scripts.json scripts/prewarm-nav.ts --range=1mo --retail-only
StandardOutput=journal
StandardError=journal
EOF

sudo tee /etc/systemd/system/macrotide-prewarm-nav.timer > /dev/null <<'EOF'
[Unit]
Description=Run Macrotide all-funds NAV append daily at 02:00 UTC

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now macrotide-prewarm-nav.timer
```

### Benchmark total-return pre-warm

Warm the curated total-return benchmark proxies (`benchmark_tr` source) so a
portfolio-vs-benchmark overlay reads deep, like-for-like history with no cold
first-open. This is `scripts/prewarm-benchmark.ts` (`npm run jobs:prewarm-benchmark`);
it warms a handful of tracking-ETF symbols through the same `getCachedSeries`
cache (Twelve Data `adjust=all`, ~20y deep). It needs `TWELVE_DATA_API_KEY`; a
few calls total, so quota is a non-issue.

**One-time backfill** (after deploy):

```sh
# Dockerized box:
scripts/run-job.sh prewarm-benchmark
# or directly:
npx -y tsx --tsconfig tsconfig.scripts.json scripts/prewarm-benchmark.ts
```

Verify depth landed (≥1 global proxy back ~5.4y+):

```sh
sqlite3 data/market.db "SELECT ticker, MIN(date), MAX(date), COUNT(*) \
  FROM nav_history WHERE ticker LIKE 'benchmark_tr:%' GROUP BY ticker;"
```

**Daily append** with `--range=1mo` (depth-aware cache keeps prior `max` depth).
Run at **23:30 UTC** — after the US close so the day's EOD point has landed,
before the 02:00 prewarm-nav slot:

```sh
sudo tee /etc/systemd/system/macrotide-prewarm-benchmark.service > /dev/null <<'EOF'
[Unit]
Description=Macrotide — benchmark total-return pre-warm (daily append)
After=network.target macrotide.service

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/opt/macrotide
EnvironmentFile=/opt/macrotide/.env.local
ExecStart=npx -y tsx --tsconfig tsconfig.scripts.json scripts/prewarm-benchmark.ts --range=1mo
StandardOutput=journal
StandardError=journal
EOF

sudo tee /etc/systemd/system/macrotide-prewarm-benchmark.timer > /dev/null <<'EOF'
[Unit]
Description=Run Macrotide benchmark TR append daily at 23:30 UTC

[Timer]
OnCalendar=*-*-* 23:30:00 UTC
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now macrotide-prewarm-benchmark.timer
```

## Updating

```sh
cd /opt/macrotide
git pull
npm ci
npm run build
sudo systemctl restart macrotide
```

Migrations run automatically on next request (the singleton DB init applies pending Drizzle migrations).

For a zero-downtime swap behind Caddy: blue/green with two systemd instances on different ports + `caddy reload` between them. Probably overkill until you have actual users.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `503` from Caddy | systemd unit isn't running. `journalctl -u macrotide -n 50`. |
| Passkey "origin mismatch" in browser | `PUBLIC_APP_URL` doesn't match the URL the browser is on. Fix .env.local + restart. |
| `/api/chat` always replies with "isn't configured yet" | `OPENROUTER_API_KEY` is missing or invalid in `.env.local`. Restart the systemd unit after editing. |
| Demo dashboard renders but data is wrong | Cookie collision across browsers. Clear `macrotide_demo` cookie, hit `/login` again. |
| `/api/chat` returns 429 immediately | IP rate limit. The default is 20 RPM; see `lib/api/rate-limit.ts`. |
| Build fails with "out of memory" | ARM64 VMs with <2 GB RAM need a swapfile. `sudo fallocate -l 2G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`. |

## Hardening checklist

Before sharing the URL with anyone:

- [ ] `AUTH_DISABLED` is **not** set in `.env.local` (auth required is the default)
- [ ] `AUTH_SECRET` is a random 32-byte value (never the default placeholder)
- [ ] `DEMO_OPENROUTER_API_KEY` is a **separate** key from your owner AI key (avoid quota burn)
- [ ] Demo turn cap (10/session) still in place in `lib/db/demo.ts`
- [ ] Rate limit (`/api/chat` 20 RPM) still in place
- [ ] ufw deny-incoming + 22/80/443 only
- [ ] HTTPS only (Caddy auto-cert + HSTS header)
- [ ] `.env.local` is `chmod 600` and owned by the service user
- [ ] Legal pages reviewed; `OPERATOR_NAME` / `CONTACT_EMAIL` / `LEGAL_JURISDICTION` set as desired
- [ ] Off-site backup configured (restic / rclone / borg)
- [ ] First demo session works from incognito (proves cookie isolation)
- [ ] Owner data is not visible to a demo session (proves DB context isolation)
- [ ] Owner account promoted to `trusted` (step 8) — otherwise you're on public-tier models
