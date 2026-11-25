# Template: ALIM Connect production (Connect ⇄ ALIM Core)

Companion to `alim-connect-production-readiness.md`. Every value below is a **placeholder that must come
from the secret manager or the deployment** — nothing here is a credential, and nothing here may be
committed with a real value. The real file lives on the host, owned by the operator, mode `600`.

Copy to the deployment host as `.env` next to `docker-compose.yml` (compose reads `./.env`), or export
the same keys into a `pm2` ecosystem file. `docker-compose.yml` already forwards every one of these keys
into the container (`ALIM_*` at lines 414–435, the platform keys near line 107).

```dotenv
# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
NODE_ENV=production
# TLS terminates at the reverse proxy in front of openwa-api:2785. The app is published on
# 127.0.0.1 only by docker-compose.yml, so it must not be reachable without that proxy.
CSP_UPGRADE_INSECURE_REQUESTS=true

# ---------------------------------------------------------------------------
# Database (PostgreSQL — never the SQLite file used for local work)
# ---------------------------------------------------------------------------
DATABASE_TYPE=postgres
DATABASE_HOST=<managed-postgres-host>
DATABASE_PORT=5432
DATABASE_NAME=<database>
DATABASE_USERNAME=<role>
DATABASE_PASSWORD=<from secret manager>
DATABASE_SSL=true
# Verify the chain. Only `false` when the provider cannot supply its CA — that disables MITM
# protection, so prefer supplying the CA over setting this.
DATABASE_SSL_REJECT_UNAUTHORIZED=true
DATABASE_SYNCHRONIZE=false
DATABASE_POOL_SIZE=10

# ---------------------------------------------------------------------------
# Application secrets (all required to boot — the production guard refuses placeholders)
# ---------------------------------------------------------------------------
# 32+ chars, not a known placeholder. Seeds the first ADMIN credential.
API_MASTER_KEY=<from secret manager>
ADMIN_EMAIL=<operator email — first dashboard account, seeded once>
ADMIN_PASSWORD=<from secret manager>
# CORS: the exact browser origins that may call the API cross-origin. A wildcard is refused in
# production. Same-origin dashboard use needs none, but name the public URL here anyway.
CORS_ORIGINS=https://<connect-host>
# The reverse proxy's address as the app sees it (its Docker bridge subnet, or the LB CIDR).
# Without it every client shares one rate-limit bucket behind the proxy, and X-Forwarded-For is ignored.
TRUSTED_PROXIES=<proxy CIDR>

# ---------------------------------------------------------------------------
# ALIM Core integration — production values, distinct from every staging value
# ---------------------------------------------------------------------------
ALIM_CONNECT_CORE_CLIENT=http
# HTTPS only outside loopback: the boot refuses plaintext http:// to a reachable host.
ALIM_CORE_BASE_URL=https://<core-host>
# The browser origin of Core that may embed Connect and post a handoff code. HTTPS in production.
ALIM_CORE_WEB_ORIGIN=https://<core-host>
ALIM_CONNECT_API_VERSION=1

# Three DIFFERENT credentials, each scoped in Core. Never reuse one value for two of them.
ALIM_CONNECT_SSO_KEY=<from secret manager — sso:exchange scope>
ALIM_CORE_APPROVAL_API_KEY=<from secret manager — approval:command scope>
ALIM_CONNECT_INGEST_KEY=<from secret manager — Core → Connect ingest header>

ALIM_CONNECT_SSO_API_HEADER=X-ALIM-CONNECT-SSO-KEY
ALIM_CORE_APPROVAL_API_HEADER=X-ALIM-CONNECT-APPROVAL-KEY
ALIM_CONNECT_SSO_AUDIENCE=connect
ALIM_CONNECT_SSO_SCOPE=whatsapp.embed
ALIM_CORE_TIMEOUT_MS=5000
ALIM_CONNECT_SSO_TIMEOUT_MS=5000
ALIM_CONNECT_REPLY_UNKNOWN=false

# Retry worker for commands Core never confirmed. The same command_id is reused, so Core deduplicates.
ALIM_CONNECT_RETRY_INTERVAL_MS=60000
ALIM_CONNECT_RETRY_BATCH_SIZE=20
ALIM_CONNECT_RETRY_MAX_ATTEMPTS=5
ALIM_CONNECT_RETRY_BASE_DELAY_MS=30000
ALIM_CONNECT_RETRY_MAX_DELAY_MS=900000
ALIM_CONNECT_RETRY_LEASE_MS=60000
```

## Checks after writing the file (no credential is printed)

```bash
# 1. Presence only — the lane guard reports set/MISSING and never a value.
set -a; . ./.env; set +a
npm run test:core-integration:lane

# 2. Route + key reach the real Core, which refuses an invented code and a probe command.
#    Both must PASS or WARN; FAIL/exit 3 means a contract or credential problem.
npm run probe:alim-core -- --all

# 3. The three integration credentials must not be equal to each other or to staging's.
#    Prints names and equality only, never values.
node -e '
const k=["ALIM_CONNECT_SSO_KEY","ALIM_CORE_APPROVAL_API_KEY","ALIM_CONNECT_INGEST_KEY"];
const v=k.map(n=>process.env[n]||"");
console.log("all set:", v.every(x=>x.length>0), "| distinct:", new Set(v.filter(Boolean)).size===v.filter(Boolean).length);
'
```

## Rollback

The file is the only change these steps make. Keep the previous file as `.env.previous-<date>` on the
host (mode `600`) before writing the new one; restoring it and restarting the container is the rollback
(`docker compose up -d --force-recreate openwa-api`, or `pm2 restart <app>`). No database change is part
of this procedure, so no data rollback is needed — see the readiness report §5 for the migration
prerequisites, which are handled separately.
