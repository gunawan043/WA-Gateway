import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Copy, KeyRound, Loader2, Send, ShieldAlert } from 'lucide-react';
import { apiKeyApi, messageApi, sessionApi, type ApiKey, type Session } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import { copyToClipboard } from '../utils/clipboard';
import { normalizePhoneDigits } from '../utils/phone';
import './SendApi.css';

/**
 * The developer-facing half of sending: one page that answers "how do I send a WhatsApp message
 * from my own script?".
 *
 * It adds no capability. The send routes and the key lifecycle already exist; what was missing was
 * one place showing the three values a script needs — base URL, credential, session id — next to a
 * request it can copy, and a test that proves the session works before the script is written.
 *
 * Deliberately not the Fonnte shape: a gateway API key opens the whole API within its role and
 * scope, which is a different privilege level from a send-only token. The page states that where an
 * operator will read it, instead of letting the two be confused.
 */

/** One copyable sample. The key is never interpolated into it — only a named placeholder. */
interface Snippet {
  id: string;
  title: string;
  description: string;
  code: string;
}

function Section({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`send-api-section ${open ? 'is-open' : ''}`}>
      <button type="button" className="send-api-section-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="send-api-section-titles">
          <span className="send-api-section-title">{title}</span>
          <span className="send-api-section-desc">{description}</span>
        </span>
        <ChevronDown size={18} className="send-api-section-chevron" aria-hidden="true" />
      </button>
      {open && <div className="send-api-section-body">{children}</div>}
    </section>
  );
}

export function SendApi() {
  useDocumentTitle('API Pengiriman');
  const { role } = useRole();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('');
  const [testState, setTestState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  const isAdmin = role === 'admin';
  // The dashboard calls the API same-origin under /api, so the page can show a URL that is correct
  // for whatever host the operator opened — no configuration to copy by hand and get wrong.
  const baseUrl = useMemo(() => `${window.location.origin}/api`, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await sessionApi.list();
      setSessions(list);
      setSessionId(current => {
        if (current && list.some(s => s.id === current)) return current;
        return (list.find(s => s.status === 'ready') ?? list[0])?.id ?? '';
      });
      // A non-admin's key list is refused (ADMIN-only, unscoped-only); asking anyway would surface a
      // 403 on a page whose whole point is to be usable by the people who send.
      if (isAdmin) setKeys(await apiKeyApi.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (id: string, text: string) => {
    if (!(await copyToClipboard(text))) return;
    setCopied(id);
    window.setTimeout(() => setCopied(c => (c === id ? null : c)), 1600);
  };

  const activeSession = sessions.find(s => s.id === sessionId);
  const sessionReady = activeSession?.status === 'ready';

  const snippets: Snippet[] = useMemo(() => {
    const endpoint = `${baseUrl}/sessions/${sessionId || '<SESSION_ID>'}/messages/send-text`;
    const chatId = '628123456789@c.us';
    return [
      {
        id: 'curl',
        title: 'Kirim teks dengan curl',
        description: 'Ganti nomor tujuan dan isi pesan. Nomor berformat 628xxx@c.us.',
        code: `curl -sS -X POST '${endpoint}' \\
  -H 'X-API-Key: $OPENWA_API_KEY' \\
  -H 'content-type: application/json' \\
  --data '{"chatId":"${chatId}","text":"Assalamualaikum, ini pesan otomatis."}'`,
      },
      {
        id: 'node',
        title: 'JavaScript (Node / fetch)',
        description: 'Dipakai dari server, n8n, Make, atau cron job Anda sendiri.',
        code: `const res = await fetch('${endpoint}', {
  method: 'POST',
  headers: {
    'X-API-Key': process.env.OPENWA_API_KEY,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    chatId: '${chatId}',
    text: 'Pesan otomatis dari sistem saya.',
  }),
});

if (!res.ok) throw new Error(\`Kirim gagal: \${res.status} \${await res.text()}\`);
console.log(await res.json());`,
      },
      {
        id: 'php',
        title: 'PHP',
        description: 'Untuk Laravel atau aplikasi PHP lain: kirim dari server, jangan dari browser.',
        code: `$ch = curl_init('${endpoint}');
curl_setopt_array($ch, [
  CURLOPT_POST           => true,
  CURLOPT_POSTFIELDS     => json_encode([
    'chatId' => '${chatId}',
    'text'   => 'Pesan otomatis dari aplikasi PHP.',
  ]),
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER     => [
    'X-API-Key: ' . getenv('OPENWA_API_KEY'),
    'content-type: application/json',
  ],
]);
$response = curl_exec($ch);
$status   = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($status < 200 || $status >= 300) {
  throw new RuntimeException("Kirim gagal: {$status} {$response}");
}`,
      },
    ];
  }, [baseUrl, sessionId]);

  const sendTest = async () => {
    const digits = normalizePhoneDigits(testTo);
    if (!sessionId || !digits || !testText.trim()) return;
    setTestState('sending');
    setTestError(null);
    try {
      await messageApi.sendText(sessionId, `${digits}@c.us`, testText.trim());
      setTestState('sent');
    } catch (err) {
      setTestState('failed');
      setTestError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return (
      <div className="send-api-page send-api-loading">
        <Loader2 className="animate-spin" size={28} />
      </div>
    );
  }

  return (
    <div className="send-api-page">
      <PageHeader
        title="API Pengiriman"
        subtitle="Kirim pesan WhatsApp otomatis dari sistem lain memakai gateway ini."
      />

      {error && (
        <div className="send-api-alert" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button type="button" className="send-api-link-btn" onClick={() => void load()}>
            Coba lagi
          </button>
        </div>
      )}

      <div className="send-api-summary">
        <div className="send-api-summary-item">
          <span className="send-api-summary-label">Base URL</span>
          <code className="send-api-summary-value">{baseUrl}</code>
        </div>
        <div className="send-api-summary-item">
          <span className="send-api-summary-label">Kredensial</span>
          <code className="send-api-summary-value">header X-API-Key</code>
        </div>
        <div className="send-api-summary-item">
          <span className="send-api-summary-label">Status sesi</span>
          <span className={`send-api-badge ${sessionReady ? 'is-ready' : 'is-offline'}`}>
            {activeSession ? (sessionReady ? 'tersambung' : activeSession.status) : 'belum ada sesi'}
          </span>
        </div>
      </div>

      <Section title="1. Pilih sesi pengirim" description="Pesan dikirim dari nomor WhatsApp sesi ini." defaultOpen>
        <label className="send-api-field">
          <span className="send-api-field-label">Sesi</span>
          <select
            className="send-api-select"
            value={sessionId}
            onChange={e => {
              setSessionId(e.target.value);
              setTestState('idle');
            }}
          >
            {sessions.length === 0 && <option value="">Belum ada sesi</option>}
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.status}
              </option>
            ))}
          </select>
        </label>
        {sessionId && !sessionReady && (
          <p className="send-api-note send-api-note-warn">
            Sesi ini berstatus <strong>{activeSession?.status}</strong>. Pesan baru terkirim setelah sesi tersambung di
            halaman Sesi.
          </p>
        )}
      </Section>

      <Section
        title="2. API key"
        description={
          isAdmin
            ? 'Key akun ini. Key lengkap hanya tampil sekali, saat dibuat.'
            : 'Hanya admin yang dapat memakai key.'
        }
        defaultOpen
      >
        {!isAdmin ? (
          <p className="send-api-note">
            Akun Anda ber-role <strong>{role ?? 'tidak diketahui'}</strong>. Minta admin membuatkan API key untuk sistem
            Anda, lalu simpan key itu di server Anda sendiri.
          </p>
        ) : (
          <>
            <div className="send-api-key-list">
              {keys.length === 0 && (
                <p className="send-api-note">
                  Belum ada API key. Buat di halaman <strong>Kunci API</strong>, lalu kembali ke sini.
                </p>
              )}
              {keys.map(key => (
                <div key={key.id} className="send-api-key-row">
                  <KeyRound size={16} />
                  <span className="send-api-key-name">{key.name}</span>
                  <code className="send-api-key-prefix">{key.keyPrefix}</code>
                  <span className={`send-api-badge ${key.isActive ? 'is-ready' : 'is-offline'}`}>
                    {key.isActive ? 'aktif' : 'nonaktif'}
                  </span>
                </div>
              ))}
            </div>
            <p className="send-api-note">
              Dashboard menyimpan key sebagai hash, jadi key lengkap <strong>tidak bisa ditampilkan ulang</strong>.
              Kalau key hilang, buat yang baru di halaman Kunci API dan cabut yang lama.
            </p>
            <a className="send-api-btn" href="/api-keys">
              <KeyRound size={15} /> Buka halaman Kunci API
            </a>
          </>
        )}
      </Section>

      <Section
        title="3. Contoh request"
        description="Salin, ganti nomor tujuan dan isi pesan, lalu jalankan dari server Anda."
        defaultOpen
      >
        {!sessionId && (
          <p className="send-api-note send-api-note-warn">
            Pilih sesi pada langkah 1 agar contoh memakai ID sesi yang benar.
          </p>
        )}
        <div className="send-api-snippets">
          {snippets.map(snippet => (
            <div key={snippet.id} className="send-api-snippet">
              <div className="send-api-snippet-head">
                <div>
                  <div className="send-api-snippet-title">{snippet.title}</div>
                  <div className="send-api-snippet-desc">{snippet.description}</div>
                </div>
                <button type="button" className="send-api-copy-btn" onClick={() => void copy(snippet.id, snippet.code)}>
                  {copied === snippet.id ? <Check size={14} /> : <Copy size={14} />}
                  {copied === snippet.id ? 'Tersalin' : 'Salin'}
                </button>
              </div>
              <pre className="send-api-code">
                <code>{snippet.code}</code>
              </pre>
            </div>
          ))}
        </div>
        <p className="send-api-hint">
          Key tidak dimasukkan ke contoh ini. Simpan di variabel lingkungan server Anda dengan nama{' '}
          <code>OPENWA_API_KEY</code>, persis seperti yang dibaca contoh di atas.
        </p>
      </Section>

      <Section title="4. Uji kirim" description="Memakai sesi dan kredensial dashboard Anda, bukan API key.">
        <div className="send-api-test">
          <label className="send-api-field">
            <span className="send-api-field-label">Nomor tujuan</span>
            <input
              className="send-api-input"
              inputMode="tel"
              placeholder="08123456789"
              value={testTo}
              onChange={e => {
                setTestTo(e.target.value);
                setTestState('idle');
              }}
            />
          </label>
          <label className="send-api-field send-api-field-grow">
            <span className="send-api-field-label">Isi pesan</span>
            <textarea
              className="send-api-input send-api-textarea"
              rows={3}
              placeholder="Uji coba pengiriman."
              value={testText}
              onChange={e => {
                setTestText(e.target.value);
                setTestState('idle');
              }}
            />
          </label>
          <button
            type="button"
            className="send-api-btn send-api-btn-primary"
            disabled={!sessionReady || !testTo.trim() || !testText.trim() || testState === 'sending'}
            onClick={() => void sendTest()}
          >
            {testState === 'sending' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            Kirim uji
          </button>
        </div>
        {testState === 'sent' && (
          <p className="send-api-note send-api-note-ok">
            <Check size={15} /> Pesan uji dikirim lewat sesi ini.
          </p>
        )}
        {testState === 'failed' && (
          <p className="send-api-note send-api-note-warn">
            <AlertCircle size={15} /> {testError ?? 'Pengiriman gagal.'}
          </p>
        )}
      </Section>

      <Section title="Batasan yang perlu diketahui" description="Agar skrip Anda tidak mengejutkan diri sendiri.">
        <ul className="send-api-list">
          <li>
            <ShieldAlert size={14} /> <strong>Key ini bukan token Fonnte.</strong> Ia membuka API gateway sesuai role
            dan scope-nya. Untuk pengirim otomatis, buat key dengan role <code>operator</code> dan batasi{' '}
            <code>allowedSessions</code> ke nomor yang memang boleh dipakai.
          </li>
          <li>
            <strong>Format nomor.</strong> Gateway menerima <code>628xxx@c.us</code>; <code>0812…</code> harus diubah
            menjadi <code>62812…</code>.
          </li>
          <li>
            <strong>Throttle.</strong> Route kirim dibatasi per menit dan per IP. Pengiriman massal akan menerima{' '}
            <code>429</code> — beri jeda dan coba ulang, jangan ulangi seketika.
          </li>
          <li>
            <strong>Jangan simpan key di browser atau aplikasi klien.</strong> Pemanggilan dilakukan dari server Anda,
            dengan key dibaca dari konfigurasi server.
          </li>
        </ul>
      </Section>
    </div>
  );
}
