#!/usr/bin/env bash
# ALIM Connect — post-deploy verification (READ-ONLY).
#
# Answers one question honestly: is this release actually serving the modules it claims, on this
# host? Every check is an HTTP observation of the running deployment, not a reading of the source, so
# a green run here is evidence about production and nothing else.
#
# It creates no approval request, redeems no SSO code, and issues no credential. Calls that would
# mutate anything are sent as empty bodies and are expected to be refused by auth before reaching a
# handler.
#
# A 404 means the route does not exist in the running build (wrong release). A 401/403/422/503 means
# the route exists and refused the call, which is what a correct deployment does to an
# unauthenticated probe. The script distinguishes the two explicitly, because conflating them is how
# "endpoint tersedia" gets claimed for a build that lacks it.
#
# Usage:
#   BASE_URL=https://alim-wa.abuhurairah.id bash scripts/deploy/verify-production.sh
set -uo pipefail

BASE_URL="${BASE_URL:-https://alim-wa.abuhurairah.id}"
BASE_URL="${BASE_URL%/}"

fails=0
warns=0
pass() { printf 'PASS  %-46s %s\n' "$1" "$2"; }
warn() { printf 'WARN  %-46s %s\n' "$1" "$2"; warns=$((warns + 1)); }
fail() { printf 'FAIL  %-46s %s\n' "$1" "$2"; fails=$((fails + 1)); }
info() { printf 'INFO  %-46s %s\n' "$1" "$2"; }

code() {
  curl -sS -o /dev/null -m 20 -w '%{http_code}' "$@" 2>/dev/null || printf '000'
}

# A route EXISTS when it answers anything other than 404/405/000.
exists() {
  local status="$1"
  case "$status" in
    404 | 405 | 000) return 1;;
    *) return 0;;
  esac
}

# `expect_route NAME METHOD PATH [extra curl args...]` — the route must exist (not 404) and must not
# be a 5xx.
expect_route() {
  local name="$1" method="$2" path="$3"
  shift 3
  local status
  status="$(code -X "$method" "$@" "$BASE_URL$path")"
  if exists "$status"; then
    if [ "${status:0:1}" = "5" ] && [ "$status" != "503" ]; then
      fail "$name" "HTTP $status — route exists but failed"
    else
      pass "$name" "HTTP $status (exists, refused as expected)"
    fi
  else
    fail "$name" "HTTP $status — route NOT in this build"
  fi
}

echo "== Health =="
ready="$(code "$BASE_URL/api/health/ready")"
[ "$ready" = "200" ] && pass "readiness" "200" || fail "readiness" "HTTP $ready"

live="$(code "$BASE_URL/api/health/live")"
[ "$live" = "200" ] && pass "liveness" "200" || fail "liveness" "HTTP $live"

echo "== Release identity =="
index_html="$(curl -sS -m 20 "$BASE_URL/" 2>/dev/null)"
[ -n "$index_html" ] && pass "dashboard document" "$(printf '%s' "$index_html" | grep -oE '<title>[^<]*</title>' | head -1)" || fail "dashboard document" "empty"

# The favicon link is what distinguishes this release's dashboard build from the previous one: the
# 82f5a1ed3 build serves /favicon-32.png and the apple-touch icon, the older one served favicon.svg.
case "$index_html" in
  *favicon-32.png*) pass "dashboard build" "this release (favicon-32.png)";;
  *favicon.svg*) warn "dashboard build" "an OLDER build is being served (favicon.svg) — the dashboard is not from this release";;
  *) warn "dashboard build" "favicon marker not recognised";;
esac

echo "== WhatsApp sessions =="
expect_route "session list" GET /api/sessions -H 'accept: application/json'
expect_route "session create" POST /api/sessions -H 'content-type: application/json' -d '{}'
expect_route "session detail" GET /api/sessions/probe -H 'accept: application/json'

echo "== Inbox =="
expect_route "inbox conversations" GET /api/sessions/probe/inbox/conversations -H 'accept: application/json'
expect_route "inbox summary" GET /api/sessions/probe/inbox/summary -H 'accept: application/json'

echo "== Approval =="
expect_route "approval ingest" POST /api/approval/requests -H 'content-type: application/json' -d '{}'
expect_route "approval list" GET /api/approval/requests -H 'accept: application/json'
expect_route "approval identities" POST /api/approval/identities -H 'content-type: application/json' -d '{}'

echo "== SSO handoff =="
handoff="$(code "$BASE_URL/api/sso/handoff")"
if exists "$handoff"; then
  pass "sso handoff page" "HTTP $handoff (exists)"
else
  fail "sso handoff page" "HTTP $handoff — route NOT in this build"
fi
# A POST without a code must be refused (400/403/422), never accepted and never 404.
sso_post="$(code -X POST "$BASE_URL/api/sso/handoff" -H 'content-type: application/json' -d '{}')"
if exists "$sso_post"; then
  pass "sso handoff post" "HTTP $sso_post (refused, as it must be without a code)"
else
  fail "sso handoff post" "HTTP $sso_post — route NOT in this build"
fi
case "$sso_post" in
  200) fail "sso handoff post" "HTTP 200 to an empty body — a handoff was accepted without a code";;
esac

echo "== API management =="
expect_route "api key list" GET /api/auth/api-keys -H 'accept: application/json'
expect_route "auth validate" POST /api/auth/validate -H 'content-type: application/json' -d '{}'

echo "== Webhook =="
expect_route "webhook list" GET /api/webhooks -H 'accept: application/json'
expect_route "webhook delivery failures" GET /api/webhooks/delivery-failures -H 'accept: application/json'

echo "== Audit =="
expect_route "audit log" GET /api/audit -H 'accept: application/json'

echo "== Response hygiene =="
headers="$(curl -sSI -m 20 "$BASE_URL/" 2>/dev/null)"
case "$headers" in
  *"strict-transport-security"*) pass "HSTS" "present";;
  *) warn "HSTS" "absent";;
esac
case "$headers" in
  *"content-security-policy"*) pass "CSP" "present";;
  *) warn "CSP" "absent";;
esac
case "$headers" in
  *"x-powered-by"*) warn "server banner" "x-powered-by is exposed";;
  *) pass "server banner" "no x-powered-by";;
esac

echo "== Public exposure =="
info "API docs" "ENABLE_SWAGGER is a boot decision; /api/docs answering 200 means Swagger is public"
docs="$(code "$BASE_URL/api/docs")"
case "$docs" in
  200) warn "swagger" "public at /api/docs";;
  *) pass "swagger" "HTTP $docs";;
esac

echo
echo "== Summary =="
echo "FAIL=$fails WARN=$warns"
if [ "$fails" -gt 0 ]; then
  echo "The deployment is NOT verified. Do not report these endpoints as available."
  exit 1
fi
if [ "$warns" -gt 0 ]; then
  echo "All required routes exist. Read every WARN before calling the release complete."
  exit 0
fi
echo "All checks passed."
