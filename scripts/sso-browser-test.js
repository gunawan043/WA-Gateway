#!/usr/bin/env node
/**
 * Drives the SSO handoff in a real browser and prints a result sheet for
 * docs/integration/alim-connect-sso-browser-test.md §6.
 *
 * This is the executable half of that document. It runs the same nine scenarios a person would
 * click through, against the two origins the harness sets up:
 *
 *   Core mock (harness)  http://localhost:4400
 *   Connect              http://localhost:2785
 *
 * Prerequisites (see the doc for the full runbook):
 *
 *   1. Connect is running with the harness as Core and the dashboard built:
 *        ALIM_CORE_BASE_URL=http://localhost:4400 \
 *        ALIM_CORE_WEB_ORIGIN=http://localhost:4400 \
 *        ALIM_CONNECT_SSO_KEY=browser-test-key \
 *        AUTH_SESSION_IDLE_TIMEOUT_MINUTES=1 \
 *        node dist/main
 *   2. node scripts/sso-browser-harness.js
 *   3. An account mapped to HARNESS_CORE_USER_ID (default `core-browser-test`).
 *
 * Usage: node scripts/sso-browser-test.js
 *
 * Env knobs:
 *   BROWSER_CHANNEL   `chrome` (default; puppeteer's bundled Chrome), or a path to another
 *                     Chromium-based binary. Firefox/Safari are NOT supported by this driver —
 *                     see §6 of the doc for how those are recorded.
 *   HEADLESS=false    watch the run in a visible window
 *   SKIP_EXPIRY=1     skip scenario 9 (it waits out the idle timeout, ~65 s)
 *   EXPIRY_WAIT_MS    how long to idle before asserting expiry (default 65000)
 *
 * Exit code: 0 when every scenario passed, 1 otherwise.
 */
'use strict';

const http = require('http');
const puppeteer = require('puppeteer');

const CONNECT_ORIGIN = (process.env.CONNECT_ORIGIN || 'http://localhost:2785').replace(/\/+$/, '');
const CORE_ORIGIN = (process.env.CORE_ORIGIN || 'http://localhost:4400').replace(/\/+$/, '');
const FOREIGN_PORT = Number(process.env.FOREIGN_PORT || 4401);
const HEADLESS = process.env.HEADLESS !== 'false';
const WAIT_MS = Number(process.env.WAIT_MS || 20000);
const EXPIRY_WAIT_MS = Number(process.env.EXPIRY_WAIT_MS || 65000);
const SKIP_EXPIRY = process.env.SKIP_EXPIRY === '1';
const CHANNEL = process.env.BROWSER_CHANNEL || 'chrome';

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(what, fn, timeout = WAIT_MS, interval = 100) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

/** The Connect frame inside the Core embed page, whichever URL it currently shows. */
function connectFrame(page) {
  return page.frames().find(frame => frame.url().startsWith(`${CONNECT_ORIGIN}/`));
}

function waitConnectFrame(page) {
  return until('the Connect iframe', () => connectFrame(page));
}

function frameText(frame) {
  return frame.evaluate(() => document.body?.innerText ?? '');
}

/** Waits for a selector inside the Connect frame, re-resolving the frame each poll. */
async function waitInConnect(page, selector, timeout = WAIT_MS) {
  return until(
    `\`${selector}\` in the Connect frame`,
    async () => {
      const frame = connectFrame(page);
      if (!frame) return false;
      return frame.evaluate(sel => Boolean(document.querySelector(sel)), selector);
    },
    timeout,
  );
}

/**
 * Reloads ONLY the embedded Connect frame.
 *
 * Reloading the top page would be the wrong test: the Core embed page issues a fresh code on every
 * load, so the iframe would be handed a new session and "does the session survive a reload?" would
 * be answered by a new login instead of by the stored one.
 */
async function reloadConnectFrame(page) {
  const frame = connectFrame(page);
  if (!frame) throw new Error('there is no Connect frame to reload');
  // The reload destroys this execution context, so the promise rejects by design.
  await frame.evaluate(() => location.reload()).catch(() => undefined);
  await until('the Connect frame to finish reloading', async () => {
    const current = connectFrame(page);
    if (!current) return false;
    const state = await current.evaluate(() => document.readyState).catch(() => null);
    return state === 'complete' || state === 'interactive';
  });
}

async function connectFrameState(page) {
  const frame = connectFrame(page);
  if (!frame) throw new Error('the Connect frame is gone');
  return frame.evaluate(() => ({
    token: sessionStorage.getItem('openwa_api_key'),
    user: sessionStorage.getItem('openwa_user'),
    cookie: document.cookie,
    hasLogout: Boolean(document.querySelector('.logout-btn')),
    hasLogin: Boolean(document.querySelector('.login-container')),
    bodyText: (document.body?.innerText ?? '').slice(0, 400),
  }));
}

/** A tiny page on a second origin, used to prove `frame-ancestors` is enforced by the browser. */
function startForeignPage() {
  const html = `<!doctype html><html><body>
<h1>Bukan ALIM Core</h1>
<iframe id="connect" src="${CONNECT_ORIGIN}/" width="900" height="600"></iframe>
</body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  return new Promise(resolve => {
    server.listen(FOREIGN_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function postHandoffFromForeignOrigin() {
  const response = await fetch(`${CONNECT_ORIGIN}/sso/handoff`, {
    method: 'POST',
    headers: {
      origin: `http://localhost:${FOREIGN_PORT}`,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'code=h_foreign_attempt&state=foreign',
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function main() {
  // Fail early and clearly if the prerequisites are not up.
  const health = await fetch(`${CONNECT_ORIGIN}/health`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(`Connect is not answering on ${CONNECT_ORIGIN}/health — start it first (see the header).`);
  }
  const harness = await fetch(`${CORE_ORIGIN}/issue?mode=valid`).catch(() => null);
  if (!harness || !harness.ok) {
    throw new Error(`the harness is not answering on ${CORE_ORIGIN}/issue — run node scripts/sso-browser-harness.js.`);
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    channel: CHANNEL === 'chrome' ? 'chrome' : undefined,
    executablePath: CHANNEL === 'chrome' ? undefined : CHANNEL,
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  const consoleErrors = [];
  const setCookies = [];
  const badResponses = [];
  const handoffPosts = [];
  const foreignServer = await startForeignPage();

  try {
    // ---- 1. Loading document renders (the GET the iframe loads first) ------------------------
    {
      const page = await browser.newPage();
      await page.goto(`${CONNECT_ORIGIN}/sso/handoff`, { waitUntil: 'domcontentloaded' });
      const text = await page.evaluate(() => document.body.innerText);
      record(
        '1. Loading page renders',
        text.includes('Menghubungkan ke ALIM Connect'),
        text.includes('Menghubungkan ke ALIM Connect') ? 'spinner + "Menghubungkan…"' : `got: ${text.slice(0, 80)}`,
      );
      await page.close();
    }

    // ---- 2. Valid handoff: iframe -> exchange -> workspace -----------------------------------
    const page = await browser.newPage();
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
    page.on('response', response => {
      const header = response.headers()['set-cookie'];
      if (header) setCookies.push({ url: response.url(), header });
      if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
    });
    page.on('request', request => {
      if (request.url().startsWith(`${CONNECT_ORIGIN}/sso/handoff`) && request.method() === 'POST') {
        handoffPosts.push(request.url());
      }
    });

    await page.goto(`${CORE_ORIGIN}/?mode=valid`, { waitUntil: 'domcontentloaded' });
    await waitConnectFrame(page);

    // Best-effort: the harness submits 150 ms after issuing the code, so the loading document can
    // still be on screen. A miss here is not a failure — scenario 1 proves the document renders.
    let loadingObserved = false;
    for (let i = 0; i < 15 && !loadingObserved; i += 1) {
      const frame = connectFrame(page);
      if (frame) {
        loadingObserved = await frame
          .evaluate(() => document.body.innerText.includes('Menghubungkan ke ALIM Connect'))
          .catch(() => false);
      }
      if (!loadingObserved) await sleep(20);
    }

    await waitInConnect(page, '.logout-btn');
    const state = await connectFrameState(page);
    const frameUrl = connectFrame(page).url();

    record(
      '2. Workspace appears in the iframe',
      state.hasLogout && frameUrl === `${CONNECT_ORIGIN}/`,
      `frame at ${frameUrl}${loadingObserved ? ', loading state observed' : ', loading state too fast to observe'}`,
    );
    record(
      '3. Session token in sessionStorage, no cookie',
      Boolean(state.token && state.token.startsWith('owa_s1_')) && state.cookie === '',
      `token=${state.token ? `${state.token.slice(0, 12)}…` : 'missing'}, cookie=${state.cookie === '' ? 'none' : state.cookie}`,
    );
    record(
      '4. Token never in a URL',
      !page.url().includes('owa_') && !frameUrl.includes('owa_') && !frameUrl.includes('code='),
      `top=${page.url()}`,
    );

    // ---- 3. Reload keeps the session and does not re-handoff ---------------------------------
    {
      const postsBefore = handoffPosts.length;
      await reloadConnectFrame(page);
      await waitInConnect(page, '.logout-btn');
      const after = await connectFrameState(page);
      record(
        '5. Reload keeps the workspace without a new handoff',
        after.hasLogout && handoffPosts.length === postsBefore,
        `handoff POSTs before/after = ${postsBefore}/${handoffPosts.length}`,
      );
    }

    // ---- 4. Logout revokes the session, not just the UI --------------------------------------
    {
      const frame = connectFrame(page);
      await frame.evaluate(() => document.querySelector('.logout-btn').click());
      await waitInConnect(page, '.login-container');
      const afterLogout = await connectFrameState(page);
      await reloadConnectFrame(page);
      await waitInConnect(page, '.login-container');
      const afterReload = await connectFrameState(page);
      record(
        '6. Logout returns to login and survives a reload',
        afterLogout.hasLogin && afterReload.hasLogin && !afterReload.token,
        `token after logout=${afterLogout.token ?? 'none'}, after reload=${afterReload.token ?? 'none'}`,
      );
    }
    await page.close();

    // ---- 5. Expired and already-used handoffs ------------------------------------------------
    for (const [mode, expected, label] of [
      ['expired', 'Handoff kedaluwarsa', '7. Expired handoff shows its own page'],
      ['used', 'Handoff sudah dipakai', '8. Reused handoff shows its own page'],
    ]) {
      const pageMode = await browser.newPage();
      await pageMode.goto(`${CORE_ORIGIN}/?mode=${mode}`, { waitUntil: 'domcontentloaded' });
      await waitConnectFrame(pageMode);
      const outcome = await until(`"${expected}" in the frame`, async () => {
        const frame = connectFrame(pageMode);
        if (!frame) return false;
        const body = await frameText(frame).catch(() => '');
        if (body.includes(expected)) return { body };
        // The route allows 5 handoffs per minute per IP. A run that follows another within that
        // window would otherwise look like a broken expiry page; name the real cause instead.
        if (/429|Too Many Requests|ThrottlerException/.test(body)) return { throttled: true };
        return false;
      });
      if (outcome.throttled) {
        throw new Error(
          'the handoff rate limit answered 429 instead of the expected page — the limiter is in-memory, ' +
            'so restart Connect (or wait 60 s) and run again',
        );
      }
      const leaked = await connectFrameState(pageMode).catch(() => ({ token: null, hasLogout: false }));
      record(label, !leaked.hasLogout && !leaked.token, `frame text: ${expected}`);
      await pageMode.close();
    }

    // ---- 6. Direct access without a handoff ---------------------------------------------------
    {
      const direct = await browser.newPage();
      await direct.goto(`${CONNECT_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
      await direct.waitForSelector('.login-container', { timeout: WAIT_MS });
      const hasLogout = await direct.evaluate(() => Boolean(document.querySelector('.logout-btn')));
      const token = await direct.evaluate(() => sessionStorage.getItem('openwa_api_key'));
      record('9. Direct access shows login, not the workspace', !hasLogout && !token, 'no session, no workspace');
      await direct.close();
    }

    // ---- 7. A foreign origin cannot frame Connect --------------------------------------------
    {
      const foreign = await browser.newPage();
      const messages = [];
      foreign.on('console', message => messages.push(message.text()));
      await foreign.goto(`http://localhost:${FOREIGN_PORT}/`, { waitUntil: 'domcontentloaded' });
      await sleep(1500);
      const blocked = messages.some(text => /frame-ancestors|Refused to frame/i.test(text));
      const refused = await postHandoffFromForeignOrigin();
      record(
        '10. Foreign origin is blocked by CSP and by the Origin check',
        blocked && refused.status === 403 && refused.body?.code === 'origin_not_allowed',
        `csp=${blocked ? 'violation reported' : 'no violation'}, POST ${refused.status} ${refused.body?.code ?? ''}`,
      );
      await foreign.close();
    }

    // ---- 8. Idle expiry ----------------------------------------------------------------------
    if (SKIP_EXPIRY) {
      record('11. Idle expiry returns to login', true, 'SKIPPED (SKIP_EXPIRY=1) — not verified in this run');
    } else {
      const expiring = await browser.newPage();
      await expiring.goto(`${CORE_ORIGIN}/?mode=valid`, { waitUntil: 'domcontentloaded' });
      await waitConnectFrame(expiring);
      await waitInConnect(expiring, '.logout-btn');
      const before = await connectFrameState(expiring);
      await sleep(EXPIRY_WAIT_MS);
      // Frame reload, not page reload: the Core page would mint a fresh code and mask the expiry.
      await reloadConnectFrame(expiring);
      await waitInConnect(expiring, '.login-container', WAIT_MS);
      const after = await connectFrameState(expiring);
      record(
        '11. Idle expiry returns to login',
        Boolean(before.token) && after.hasLogin && !after.token,
        `idle ${Math.round(EXPIRY_WAIT_MS / 1000)}s, token cleared=${!after.token}`,
      );
      await expiring.close();
    }

    // ---- 9. Cookie hygiene and console ------------------------------------------------------
    const connectCookies = setCookies.filter(entry => entry.url.startsWith(CONNECT_ORIGIN));
    record(
      '12. No Set-Cookie from Connect and no console errors',
      connectCookies.length === 0 && consoleErrors.length === 0,
      `set-cookie=${connectCookies.length}, console errors=${consoleErrors.length}${
        consoleErrors.length ? `: ${consoleErrors.slice(0, 2).join(' | ')}` : ''
      }, http>=400=${badResponses.length ? badResponses.join(' | ') : 'none'}`,
    );

    console.log(`\nBrowser: ${await browser.version()}`);
    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} scenarios passed`);
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise(resolve => foreignServer.close(resolve));
  }
}

main().catch(error => {
  console.error(`\nBrowser test could not complete: ${error.message}`);
  process.exitCode = 1;
});
