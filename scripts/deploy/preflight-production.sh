#!/usr/bin/env bash
# ALIM Connect — production pre-deploy check (READ-ONLY).
#
# Run this on the production host BEFORE any `docker compose up`. It changes nothing: it reads the
# environment, inspects the running stack, and resolves DNS/TLS. Every line is a fact the operator
# needs at the moment they decide to deploy, gathered in one place so the decision is not made from
# memory.
#
# It deliberately reports rather than fixes. A failed check means "do not deploy yet", not "the
# script will sort it out".
#
# Usage:
#   bash scripts/deploy/preflight-production.sh
#
# Exit: 0 when there is no FAIL, 1 otherwise.
set -uo pipefail

PUBLIC_HOST="${PUBLIC_HOST:-alim-wa.abuhurairah.id}"
CORE_HOST="${CORE_HOST:-alim.abuhurairah.id}"
LOCAL_PORT="${LOCAL_PORT:-2785}"

fails=0
infos=0
pass() { printf 'PASS  %-34s %s\n' "$1" "$2"; }
info() { printf 'INFO  %-34s %s\n' "$1" "$2"; infos=$((infos + 1)); }
fail() { printf 'FAIL  %-34s %s\n' "$1" "$2"; fails=$((fails + 1)); }

# A secret is checked for PRESENCE only. Nothing here prints a value: the output of this script is
# meant to be pasted into a ticket or a report.
present() {
  local name="$1"
  local value="${!name:-}"
  if [ -n "$value" ]; then pass "env $name" "set"; else fail "env $name" "missing"; fi
}

weak_secret() {
  local name="$1"
  local value="${!name:-}"
  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    '' | openwa | minioadmin | changing | changeme | change-me | password | secret | admin | 123456 | test | demo | root | dev-master-key | dev-admin-key)
      fail "secret $name" "empty or a known default";;
    *) pass "secret $name" "set (length ${#value})";;
  esac
}

echo "== Environment =="
if [ "${NODE_ENV:-}" = "production" ]; then
  pass "NODE_ENV" "production"
else
  fail "NODE_ENV" "is '${NODE_ENV:-unset}' — must be 'production'"
fi

if [ -n "${ALIM_CONNECT_IMAGE:-}" ]; then
  case "$ALIM_CONNECT_IMAGE" in
    *@sha256:*) pass "ALIM_CONNECT_IMAGE" "digest-pinned";;
    *) fail "ALIM_CONNECT_IMAGE" "not pinned by digest ($ALIM_CONNECT_IMAGE)";;
  esac
else
  fail "ALIM_CONNECT_IMAGE" "unset — the release image is chosen by digest, never by building"
fi

echo "== Core integration =="
core_url="${ALIM_CORE_BASE_URL:-}"
case "$core_url" in
  https://*) pass "ALIM_CORE_BASE_URL" "https (${core_url%/})";;
  http://127.* | http://localhost* | http://\[::1\]*) fail "ALIM_CORE_BASE_URL" "loopback http — fine for dev, never for production";;
  http://*) fail "ALIM_CORE_BASE_URL" "plaintext http — the approval and SSO keys would travel readable";;
  '') fail "ALIM_CORE_BASE_URL" "unset";;
  *) fail "ALIM_CORE_BASE_URL" "not an http(s) URL";;
esac

if [ "${ALIM_CONNECT_CORE_CLIENT:-}" = "http" ]; then
  pass "ALIM_CONNECT_CORE_CLIENT" "http (real Core)"
else
  fail "ALIM_CONNECT_CORE_CLIENT" "'${ALIM_CONNECT_CORE_CLIENT:-unset}' — a mock Core can approve permits Core never approved"
fi

origin="${ALIM_CORE_WEB_ORIGIN:-}"
case "$origin" in
  https://*) pass "ALIM_CORE_WEB_ORIGIN" "https";;
  http://127.* | http://localhost* | http://\[::1\]*) fail "ALIM_CORE_WEB_ORIGIN" "loopback http";;
  '') fail "ALIM_CORE_WEB_ORIGIN" "unset — SSO stays disabled";;
  *) fail "ALIM_CORE_WEB_ORIGIN" "must be an https origin with no path";;
esac

present ALIM_CORE_APPROVAL_API_KEY
present ALIM_CONNECT_SSO_KEY
present ALIM_CONNECT_INGEST_KEY

if [ -n "${ALIM_CORE_APPROVAL_API_KEY:-}" ] && [ -n "${ALIM_CONNECT_SSO_KEY:-}" ]; then
  if [ "${ALIM_CORE_APPROVAL_API_KEY}" = "${ALIM_CONNECT_SSO_KEY}" ]; then
    fail "separation" "the approval key and the SSO key are the SAME value — Core scopes them differently"
  else
    pass "separation" "approval key and SSO key are distinct"
  fi
else
  info "separation" "cannot compare — one of the two keys is unset"
fi

echo "== Application secrets =="
# UserSeedService creates the first dashboard account only when users is empty AND both variables
# are set; a password under 12 characters is refused (warning, then no account). Getting this wrong
# is not fatal at boot, which is why it has to be checked here — the operator would otherwise find
# out at the login screen.
if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  if [ "${#ADMIN_PASSWORD}" -ge 12 ]; then
    pass "admin seed" "both set, password ${#ADMIN_PASSWORD} chars"
  else
    fail "admin seed" "ADMIN_PASSWORD shorter than 12 characters — no account will be created"
  fi
elif [ -n "${ADMIN_EMAIL:-}" ] || [ -n "${ADMIN_PASSWORD:-}" ]; then
  fail "admin seed" "ADMIN_EMAIL and ADMIN_PASSWORD must be set together"
else
  info "admin seed" "unset — no dashboard account is created on this boot"
fi

if [ -z "${API_MASTER_KEY:-}" ]; then
  info "API_MASTER_KEY" "unset — first boot generates one; a deliberate generated key is acceptable"
else
  if [ "${#API_MASTER_KEY}" -ge 32 ]; then
    pass "API_MASTER_KEY" "set (${#API_MASTER_KEY} chars)"
  else
    fail "API_MASTER_KEY" "shorter than 32 characters"
  fi
  weak_secret API_MASTER_KEY
fi

case "${ALLOW_DEV_API_KEY:-}" in
  true | TRUE) fail "ALLOW_DEV_API_KEY" "true — seeds the public dev-admin-key";;
  *) pass "ALLOW_DEV_API_KEY" "not enabled";;
esac

echo "== CORS and proxy =="
cors="${CORS_ORIGINS:-}"
case "$cors" in
  '') fail "CORS_ORIGINS" "unset — set it to https://${PUBLIC_HOST}";;
  '*') fail "CORS_ORIGINS" "wildcard — production refuses it, leaving same-origin only";;
  *'*'*) fail "CORS_ORIGINS" "contains a wildcard";;
  http://*) fail "CORS_ORIGINS" "contains a plaintext origin";;
  *) pass "CORS_ORIGINS" "explicit allowlist ($cors)";;
esac

if [ -z "${TRUSTED_PROXIES:-}" ]; then
  info "TRUSTED_PROXIES" "unset — behind a proxy every client shares ONE rate-limit bucket"
else
  pass "TRUSTED_PROXIES" "set (${TRUSTED_PROXIES})"
fi

echo "== Database =="
if [ "${DATABASE_TYPE:-}" = "postgres" ]; then
  pass "DATABASE_TYPE" "postgres"
  present DATABASE_HOST
  present DATABASE_NAME
  present DATABASE_USERNAME
  weak_secret DATABASE_PASSWORD
  if [ "${DATABASE_SSL:-}" = "true" ]; then
    pass "DATABASE_SSL" "true"
  else
    fail "DATABASE_SSL" "not true — a managed database reached without TLS"
  fi
  if [ "${DATABASE_SSL_REJECT_UNAUTHORIZED:-}" = "false" ]; then
    fail "DATABASE_SSL_REJECT_UNAUTHORIZED" "false — certificate chain is not verified; prefer NODE_EXTRA_CA_CERTS with verification on"
  else
    pass "DATABASE_SSL_REJECT_UNAUTHORIZED" "verified"
  fi
else
  info "DATABASE_TYPE" "'${DATABASE_TYPE:-unset}' — sqlite is the built-in default, not a production data store"
fi

if [ "${MAIN_DATABASE_SYNCHRONIZE:-}" = "true" ]; then
  fail "MAIN_DATABASE_SYNCHRONIZE" "true — writes schema changes the migration ledger will not record"
else
  pass "MAIN_DATABASE_SYNCHRONIZE" "not enabled"
fi

echo "== Optional services =="
info "REDIS_ENABLED" "${REDIS_ENABLED:-0 (in-memory fan-out; single replica only)}"
info "STORAGE_TYPE" "${STORAGE_TYPE:-local} (MinIO/S3 needed only for shared or external media)"

echo "== Filesystem =="
if [ -d ./data ]; then
  pass "data volume" "present at ./data"
else
  info "data volume" "./data does not exist yet — the named volume openwa-data will be created on first start"
fi

if [ "${SERVE_DASHBOARD:-}" = "false" ]; then
  fail "SERVE_DASHBOARD" "false — the dashboard would not be served on this host"
else
  pass "SERVE_DASHBOARD" "enabled (bundled SPA served by the API)"
fi

echo "== Network =="
if command -v dig >/dev/null 2>&1; then
  a="$(dig +short A "$PUBLIC_HOST" | tr '\n' ' ')"
  [ -n "$a" ] && pass "DNS $PUBLIC_HOST" "A $a" || fail "DNS $PUBLIC_HOST" "no A record"
  b="$(dig +short A "$CORE_HOST" | tr '\n' ' ')"
  [ -n "$b" ] && pass "DNS $CORE_HOST" "A $b" || fail "DNS $CORE_HOST" "no A record"
else
  info "DNS" "dig not installed; resolve $PUBLIC_HOST and $CORE_HOST by hand"
fi

if command -v curl >/dev/null 2>&1; then
  tls="$(curl -sS -o /dev/null -m 15 -w '%{ssl_verify_result}' "https://${PUBLIC_HOST}/" 2>/dev/null)"
  [ "$tls" = "0" ] && pass "TLS $PUBLIC_HOST" "certificate verifies" || fail "TLS $PUBLIC_HOST" "verify result '${tls:-no response}'"

  local_ready="$(curl -sS -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${LOCAL_PORT}/api/health/ready" 2>/dev/null)"
  info "local readiness" "127.0.0.1:${LOCAL_PORT} -> ${local_ready:-no response} (502/000 expected before the first start)"
else
  info "TLS/local" "curl not installed"
fi

echo "== Running stack =="
if command -v docker >/dev/null 2>&1; then
  ver="$(docker compose version --short 2>/dev/null || echo unknown)"
  info "compose version" "$ver"
  running="$(docker ps --filter 'name=openwa-api' --format '{{.Image}} {{.Status}}' 2>/dev/null)"
  info "openwa-api" "${running:-not running}"
  vols="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -c openwa-data || true)"
  [ "${vols:-0}" -ge 1 ] && pass "openwa-data volume" "exists — do not remove it on deploy" || info "openwa-data volume" "absent (first deploy)"
else
  info "docker" "not installed on this host (running this from somewhere else?)"
fi

echo
echo "== Summary =="
echo "FAIL=$fails INFO=$infos"
if [ "$fails" -gt 0 ]; then
  echo "DO NOT DEPLOY until every FAIL is understood and either fixed or accepted in writing."
  exit 1
fi
echo "No FAIL. Review the INFO lines, then proceed with the documented release procedure."
