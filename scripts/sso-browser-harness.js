#!/usr/bin/env node
/**
 * Reproducible browser harness for the WhatsApp Connect SSO handoff.
 *
 * It plays the two roles ALIM Core plays in the real flow, on ONE origin:
 *
 *   GET  /                              the page Core embeds Connect in; it issues a code, then
 *                                       auto-submits the handoff form into the Connect iframe
 *   GET  /issue?mode=valid|expired|used  a fresh one-time code (or a deliberately broken one)
 *   POST /api/connect/v1/sso/exchange    the server-to-server exchange Connect calls
 *
 * Usage (three terminals):
 *
 *   1. Build and start Connect with the harness as Core:
 *        ALIM_CORE_BASE_URL=http://localhost:4400 \
 *        ALIM_CORE_WEB_ORIGIN=http://localhost:4400 \
 *        ALIM_CONNECT_SSO_KEY=browser-test-key \
 *        npm run build:all && node dist/main
 *
 *   2. Create a Connect account and map it to the harness identity (CORE_USER_ID below), e.g. via
 *      POST /api/auth/users with an ADMIN key and `coreUserId: "core-browser-test"`, or PATCH an
 *      existing account. The harness refuses to mint a session for any other id.
 *
 *   3. node scripts/sso-browser-harness.js
 *      then open http://localhost:4400 in Chrome, Safari and Firefox.
 *
 * The script is NOT production code and is not imported by the application. It exists so the
 * cross-origin iframe / form POST / sessionStorage / logout checks in
 * docs/integration/alim-connect-sso-browser-test.md are reproducible instead of described.
 */
'use strict';

const http = require('http');
const { randomBytes } = require('crypto');

const PORT = Number(process.env.HARNESS_PORT || 4400);
const CONNECT_ORIGIN = (process.env.CONNECT_ORIGIN || 'http://localhost:2785').replace(/\/+$/, '');
const SSO_KEY = process.env.ALIM_CONNECT_SSO_KEY || 'browser-test-key';
const SSO_HEADER = (process.env.ALIM_CONNECT_SSO_API_HEADER || 'X-ALIM-CONNECT-SSO-KEY').toLowerCase();
const CORE_USER_ID = process.env.HARNESS_CORE_USER_ID || 'core-browser-test';

/** code -> { state, coreUserId } */
const codes = new Map();

function issue(mode) {
  const code = `h_${randomBytes(16).toString('hex')}`;
  codes.set(code, { state: mode === 'valid' ? 'valid' : mode, coreUserId: CORE_USER_ID });
  return code;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const EMBED_PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>ALIM Core — WhatsApp Connect (harness)</title>
<style>
 body{margin:0;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
 header{padding:12px 18px;background:#1e293b;display:flex;gap:16px;align-items:center;font-size:14px}
 iframe{display:block;width:100%;height:calc(100vh - 46px);border:0;background:#f8fafc}
 code{color:#86efac}
</style></head>
<body>
<header>
  <strong>ALIM Core (harness)</strong>
  <span>mode:
    <a href="/?mode=valid" style="color:#7dd3fc">valid</a> ·
    <a href="/?mode=expired" style="color:#7dd3fc">expired</a> ·
    <a href="/?mode=used" style="color:#7dd3fc">used</a>
  </span>
  <span>Connect: <code>${CONNECT_ORIGIN}</code></span>
</header>
<iframe name="connect" src="${CONNECT_ORIGIN}/sso/handoff" title="WhatsApp Connect"></iframe>
<form id="handoff" method="POST" action="${CONNECT_ORIGIN}/sso/handoff" target="connect" hidden>
  <input name="code" id="code">
  <input name="state" value="browser-harness">
</form>
<script>
  const mode = new URLSearchParams(location.search).get('mode') || 'valid';
  fetch('/issue?mode=' + encodeURIComponent(mode), { cache: 'no-store' })
    .then(r => r.json())
    .then(({ code }) => {
      document.getElementById('code').value = code;
      // Give the iframe a moment to paint the Connect loading page first.
      setTimeout(() => document.getElementById('handoff').submit(), 150);
    })
    .catch(() => { document.body.insertAdjacentHTML('beforeend', '<p>Harness gagal menerbitkan code.</p>'); });
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(EMBED_PAGE);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/issue') {
    const mode = url.searchParams.get('mode') || 'valid';
    json(res, 200, { code: issue(mode), coreUserId: CORE_USER_ID });
    return;
  }

  // Chrome asks every page for a favicon. Answering it keeps the browser console clean, so a real
  // console error during a browser test is not buried under a fixture's 404.
  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/connect/v1/sso/exchange') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.headers[SSO_HEADER] !== SSO_KEY) {
        json(res, 401, { success: false, message: 'invalid key', data: null, errors: null });
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        json(res, 422, { success: false, message: 'invalid payload', data: null, errors: { code: 'invalid_payload' } });
        return;
      }
      const record = codes.get(body.code);
      if (!record) {
        json(res, 404, { success: false, message: 'not found', data: null, errors: { code: 'code_not_found' } });
        return;
      }
      if (record.state === 'expired') {
        json(res, 410, { success: false, message: 'expired', data: null, errors: { code: 'code_expired' } });
        return;
      }
      if (record.state === 'used') {
        json(res, 409, { success: false, message: 'used', data: null, errors: { code: 'code_already_used' } });
        return;
      }
      record.state = 'used';
      json(res, 200, {
        core_user_id: record.coreUserId,
        name: 'Browser Test Operator',
        email: 'browser-test@example.com',
        audience: 'connect',
        scope: 'whatsapp.embed',
        issued_at: new Date().toISOString(),
        redeemed_at: new Date().toISOString(),
      });
    });
    return;
  }

  json(res, 404, { message: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SSO browser harness on http://localhost:${PORT}`);
  console.log(`  Core web origin : http://localhost:${PORT}`);
  console.log(`  Connect origin  : ${CONNECT_ORIGIN}`);
  console.log(`  Core user id    : ${CORE_USER_ID}`);
  console.log('Open the harness URL in Chrome, Safari and Firefox.');
});
