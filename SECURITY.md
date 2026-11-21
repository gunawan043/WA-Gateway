# Security Policy

OpenWA is a self-hosted WhatsApp API gateway. It handles API-key authentication,
WhatsApp session credentials, message data, and — optionally — access to the Docker
socket. Security matters here, and we appreciate responsible disclosure.

## Supported versions

Security fixes land on the latest minor release (currently 0.30.x). Older minor
lines receive no backports — please upgrade older deployments.

| Version | Supported          |
| ------- | ------------------ |
| 0.30.x  | :white_check_mark: |
| < 0.30  | :x:                |

## Reporting a vulnerability

**Please do not open a public issue, discussion, or PR for a security vulnerability.**

Report it privately through either channel:

- **GitHub Security Advisories** (preferred) — open a private report at
  <https://github.com/rmyndharis/OpenWA/security/advisories/new>
- **Email** — yudhi@rmyndharis.com

Please include, where possible:

- A description of the issue and its impact
- Steps to reproduce or a proof of concept
- Affected version(s) and deployment details (Docker / bare metal, database, engine)

### What to expect

- An acknowledgement, typically within a few days
- An assessment, and — where applicable — a coordinated fix and release
- Credit in the advisory / release notes, unless you'd prefer to remain anonymous

## Hardening notes for operators

OpenWA already ships several hardening measures: API-key auth with roles
(ADMIN / OPERATOR / VIEWER), optional outbound webhook SSRF protection, a production
CORS policy (wildcard origins refused in production), request body-size limits, a
non-root application container, path-containment checks on storage import/export,
and a Docker socket-proxy as the sole gateway to the Docker daemon.

When exposing OpenWA, please review the security-relevant configuration documented in
the README and `docs/` — in particular `CORS_ORIGINS`, `ALLOW_DEV_API_KEY`,
`ENABLE_SWAGGER`, `WEBHOOK_SSRF_PROTECT`, `BODY_SIZE_LIMIT`, `ADMIN_EMAIL` /
`ADMIN_PASSWORD` and the Docker proxy setup. Never expose the dashboard/API to the
public internet with the development API key enabled.

If you created your `.env` by copying `.env.example` before 0.16.0, check it for
`ENABLE_SWAGGER=true`. Earlier templates shipped that line uncommented alongside
`NODE_ENV=production`, so a copied file pinned the opt-in that production otherwise
withholds, and `/api/docs` is served outside the API-key guard. Comment the line out or
set it to `false` to restore the production default. The bundled Docker Compose files
(`docker-compose.yml` and `docker-compose.dev.yml`) are affected too: Compose substitutes
`ENABLE_SWAGGER` from the `.env` next to the compose file and forwards it to the container.
Fix the line there, then run `docker compose up -d` so the container is recreated with the
new value. The Helm chart does not set `ENABLE_SWAGGER`.

### Plugins are full host trust — by design

Installing or enabling a plugin is executing third-party code on the host that runs OpenWA.
This is inherent to what a plugin IS here: the sandbox (a `worker_threads` isolate with a
capped heap, an allowlisted environment, a deny-by-default network manifest for
`ctx.net.fetch`, and a capability router with per-call timeouts) contains a buggy or
runaway plugin — it is NOT a security boundary against a malicious one. A worker shares
the process's filesystem and OS privileges with the API, so it can reach anything the API
container can, including the process environment, the data volume and the `docker-proxy`
described below. See [docs/30-plugin-sandboxing.md](docs/30-plugin-sandboxing.md) for the
full list.

The compensating gates on the install path:

- every lifecycle route requires an **unscoped ADMIN** key;
- install URLs are fetched behind the SSRF guard, with redirects re-validated per hop;
- plain-`http` URLs require a `#sha256=` content pin, and in production **every** URL
  install does (`PLUGIN_INSTALL_REQUIRE_PIN`, opt-out documented in `.env.example`);
- the package manifest is strictly validated and symlink traps are detected at unpack.

If you operate a fleet of plugins you do not fully trust, do not install them into the
OpenWA process — run them in a separate container/VM with an OS-level sandbox and reach
OpenWA over the API like any other client.

### Docker socket proxy — scope and residual risk

The application container never mounts `/var/run/docker.sock`; it reaches the daemon
only through the bundled `docker-proxy` sidecar (pinned `tecnativa/docker-socket-proxy`),
which listens solely on an internal Compose network that no other container joins.
The proxy enables only the endpoint families the built-in datastore orchestration
needs (`CONTAINERS`, `IMAGES`, `VOLUMES`, `PING`) plus its single `POST`
method switch.

This is **not** a fine-grained privilege boundary, and we deliberately do not claim
it as one:

- The proxy's method gate is all-or-nothing (`deny unless METH_GET || env(POST)`):
  with `POST` enabled, every HTTP method — including `DELETE` — is admitted to the
  enabled paths. Its `DELETE` env flag is dead config and is no longer set.
- The proxy cannot scope container-create payloads (image, bind mounts, privileges).
  A compromised API container could therefore create a container with a host
  bind-mount, which is host-root-equivalent.

Mitigations in place: the proxy is unreachable except from `openwa-api` (dedicated
`internal: true` network; any plugin loaded into `openwa-api` shares that reach), the
orchestration endpoints require an ADMIN-role API key, both teardown and start are
constrained to the three managed profiles (`postgres`, `redis`, `minio`) — non-managed
names are dropped before reaching `DockerService` — and OpenWA itself never issues
deletes (profile teardown is stop-only). If you do not use the built-in datastore
orchestration (Dashboard → Infrastructure built-in toggles), disable the proxy entirely —
see the `docker-proxy` comments in `docker-compose.yml`; `DockerService` then reports
Docker unavailable and orchestration degrades gracefully.

### Dashboard accounts (email + password)

The dashboard can be signed in to with an email and a password instead of pasting an API
key. This does not add a second kind of principal: every account owns exactly one
`api_keys` row, and a session token resolves to that row before the guard runs, so roles,
scopes and audit attribution are the same. What an operator should know:

- **The account's key is never handed out.** Its plaintext is generated and discarded at
  creation, so the only way to use it is by signing in. `PATCH`/`DELETE` on
  `/api/auth/api-keys/:id` answer `409` for a user-managed key rather than orphan the
  account — delete the user instead.
- **Sessions are revocable server-side.** The token (`owa_s1_<64 hex>`) is stored only as a
  hash; logout, a password change, an admin reset and disabling the account each cut the
  matching sessions immediately, including a connected WebSocket (the sweep re-reads the
  session rows and disconnects what no longer resolves). Sessions expire after
  `AUTH_SESSION_TTL_HOURS` (default 168).
- **Login is throttled per IP** at 5 requests a minute and 20 an hour. An unknown email, a
  wrong password and a disabled account all answer the same `401`, and an unknown email
  still pays for one scrypt verification, so the route is not an account oracle.
- **Passwords are scrypt** (`N=2^15, r=8, p=1`, 16-byte salt, 64-byte key) and must be at
  least 12 characters. There is no email delivery — no reset link and no verification mail
  — so a lost password is reset by another admin.
- **Seed the first account from the environment, not from a default.** `ADMIN_EMAIL` and
  `ADMIN_PASSWORD` are read only on the first boot of an empty `users` table, must be set
  together, and a password under 12 characters refuses the boot. Change the seeded password
  after the first sign-in; the seed does not overwrite an existing row.
- **The last-admin invariant covers accounts too.** Demoting or disabling the last admin
  user is refused unless another usable unscoped admin key survives, so an operator cannot
  lock everyone out by editing the one account.

See [docs/04-security-design.md](docs/04-security-design.md#dashboard-sign-in-email--password)
for the full model and [docs/32-laravel-integration.md](docs/32-laravel-integration.md) for
giving an application its own scoped key instead.

### Session-restricted API keys

An API key can be restricted to a subset of sessions (`allowedSessions`). A key
with a non-empty restriction is denied on every route that acts on the whole
deployment rather than on a single session:

- Infrastructure routes (`/api/infra/*`)
- API-key lifecycle routes (`/api/auth/api-keys/*`)
- Plugin installation, lifecycle and activation (`/api/plugins/*`, including
  `PUT /api/plugins/:id/sessions`, which replaces the whole activation set);
  only the per-session config override (`PUT /api/plugins/:id/config/:sessionId`)
  remains available, scoped to the sessions the key allows
- Cross-session statistics (`GET /api/stats/overview`, `GET /api/stats/messages`)
- Application settings (`GET /api/settings`)
- Session creation (`POST /api/sessions`)
- Session egress proxy configuration (`PATCH /api/sessions/:sessionId/proxy`)
- The queue dashboard (`/api/admin/queues`)

Redriving a dead-lettered integration delivery also fails closed (`404`) when
the instance sits outside the key's scope, so retained dead-letter rows cannot
be re-dispatched across the boundary. Per-session routes for the sessions the
key allows remain available, and keys without an `allowedSessions` restriction
are unaffected.
