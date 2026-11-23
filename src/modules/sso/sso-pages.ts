/**
 * The HTML the browser sees for the WhatsApp Connect SSO handoff.
 *
 * These pages are served from Connect's own origin, inside the iframe Core embeds. They exist
 * because the handoff is a form POST: the browser navigates here, and this document is the only
 * place a Connect session token can be handed to the dashboard without putting it in a URL.
 *
 * The token is written to `sessionStorage` — the same slot the email/password login uses — and the
 * document is immediately replaced by the workspace. `Cache-Control: no-store` (set by the
 * controller) keeps a back-navigation from replaying a page holding a live token, and no token ever
 * appears in a URL, a referrer or a log.
 */

export interface PageOptions {
  nonce: string;
  /** The Core origin for the "back" action, or null when it is not configured. */
  coreOrigin: string | null;
}

export interface SuccessPageOptions extends PageOptions {
  token: string;
}

export interface ErrorPageOptions extends PageOptions {
  title: string;
  message: string;
  /** A short, safe hint for the person. Never includes a code, key or Core internals. */
  hint?: string;
}

const STYLES = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#f8fafc;color:#1e293b}
.card{width:100%;max-width:420px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;
  padding:28px;box-shadow:0 10px 30px rgba(15,23,42,.08);text-align:center}
.brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:18px;
  font-weight:700;font-size:15px;color:#0f172a}
.dot{width:10px;height:10px;border-radius:50%;background:#25d366;flex:none}
h1{font-size:18px;line-height:1.35;margin:0 0 8px}
p{font-size:14px;line-height:1.55;color:#64748b;margin:0 0 14px}
.hint{font-size:13px;color:#94a3b8;margin-top:14px}
a.button{display:inline-block;margin-top:6px;padding:10px 16px;border-radius:10px;
  background:#25d366;color:#06301a;font-weight:600;font-size:14px;text-decoration:none}
a.button:hover{background:#1da851;color:#fff}
a.secondary{display:inline-block;margin-top:10px;color:#64748b;font-size:13px;text-decoration:underline}
.spinner{width:34px;height:34px;margin:0 auto 16px;border-radius:50%;
  border:3px solid #e2e8f0;border-top-color:#25d366;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation:none}}
`;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const backAction = (coreOrigin: string | null): string => {
  if (!coreOrigin) return '';
  return `<a class="button" href="${escapeHtml(coreOrigin)}" rel="noopener">Kembali ke ALIM Core</a>`;
};

const documentShell = (nonce: string, title: string, body: string): string => `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} — ALIM Connect</title>
<style nonce="${escapeHtml(nonce)}">${STYLES}</style>
</head>
<body>
<main class="card">
  <div class="brand"><span class="dot" aria-hidden="true"></span>ALIM Connect</div>
  ${body}
</main>
</body>
</html>`;

/**
 * The page an embedded iframe can load while the handoff is pending. A browser keeps this document
 * on screen until the POST response arrives, which is the only way to show a Connect-owned loading
 * state for a server-side exchange.
 */
export function renderHandoffLoadingPage(options: PageOptions): string {
  return documentShell(
    options.nonce,
    'Menghubungkan',
    `<div class="spinner" role="status" aria-label="Menghubungkan"></div>
     <h1>Menghubungkan ke ALIM Connect…</h1>
     <p>Menyiapkan sesi dari ALIM Core. Jangan tutup jendela ini.</p>`,
  );
}

/**
 * The success page. The token is injected as a JSON string literal, and the only dynamic value is a
 * server-generated `owa_s1_<hex>` token — never Core-controlled text, which is why no escaping of
 * Core's name/email is needed here (they are not rendered at all; the dashboard fetches the account
 * from `/api/auth/me` after the redirect).
 */
export function renderHandoffSuccessPage(options: SuccessPageOptions): string {
  const tokenLiteral = JSON.stringify(options.token).replace(/</g, '\\u003c');
  return documentShell(
    options.nonce,
    'Berhasil masuk',
    `<div class="spinner" role="status" aria-label="Mengalihkan"></div>
     <h1>Berhasil masuk</h1>
     <p>Mengalihkan ke workspace WhatsApp Connect…</p>
     <p class="hint" id="storage-error" hidden>
       Browser memblokir penyimpanan sesi pada iframe ini. Buka ALIM Connect di tab baru dari ALIM Core.
     </p>
     <noscript><p class="hint">JavaScript diperlukan untuk menyelesaikan proses masuk.</p></noscript>
     <script nonce="${escapeHtml(options.nonce)}">
(function () {
  try {
    sessionStorage.removeItem('openwa_user');
    sessionStorage.setItem('openwa_api_key', ${tokenLiteral});
  } catch (error) {
    var note = document.getElementById('storage-error');
    if (note) note.hidden = false;
    return;
  }
  window.location.replace('/');
})();
     </script>`,
  );
}

/**
 * A refusal page. The HTTP status carries the machine-readable outcome; this page carries the
 * person-readable one. Neither includes the handoff code, the SSO key or Core's internal context.
 */
export function renderHandoffErrorPage(options: ErrorPageOptions): string {
  const hint = options.hint ? `<p class="hint">${escapeHtml(options.hint)}</p>` : '';
  return documentShell(
    options.nonce,
    options.title,
    `<h1>${escapeHtml(options.title)}</h1>
     <p>${escapeHtml(options.message)}</p>
     ${hint}
     ${backAction(options.coreOrigin)}
     <a class="secondary" href="/" rel="noopener">Buka ALIM Connect langsung</a>`,
  );
}
