import { parseCoreWebOrigin } from '../../config/core-web-origin';
import { resolveApprovalCoreClient } from '../../config/configuration';

/**
 * The ALIM Core connection surface, described once.
 *
 * Every value here is an environment key the application already reads; this table adds no new
 * configuration. It exists so the settings page and the API that saves it cannot disagree about
 * which keys belong to the integration, which of them are secrets, and what shape a valid value has.
 * Adding a key to the integration therefore means adding a row here, not editing a second list in
 * the dashboard.
 */
export type AlimCoreFieldKind = 'url' | 'secret' | 'text' | 'enum' | 'integer' | 'boolean';

export interface AlimCoreFieldSpec {
  key: string;
  /** Group the dashboard renders the field under. */
  section: 'core' | 'sso' | 'approval' | 'ingest' | 'retry';
  label: string;
  kind: AlimCoreFieldKind;
  /** Documented default, applied when the key holds nothing. Empty for keys with no default. */
  defaultValue?: string;
  /** Allowed values for `enum`. */
  choices?: readonly string[];
  /** Empty value means "integration disabled" rather than a broken configuration. */
  optional?: boolean;
  help: string;
}

/**
 * The client modes, and why `mock` is offered at all: it is the development contract client, and
 * the production gate refuses it at boot. The page shows it as a choice because hiding it would
 * leave an unrecognised value's behaviour undocumented; selecting it in production is refused before
 * anything is written.
 */
export const CORE_CLIENT_CHOICES = ['disabled', 'http', 'mock'] as const;

export const ALIM_CORE_FIELDS: readonly AlimCoreFieldSpec[] = [
  // ── Core connection ────────────────────────────────────────────────────────────────────────────
  {
    key: 'ALIM_CONNECT_CORE_CLIENT',
    section: 'core',
    label: 'Mode integrasi',
    kind: 'enum',
    choices: CORE_CLIENT_CHOICES,
    defaultValue: 'mock',
    help:
      '"http" memakai ALIM Core sungguhan. "disabled" menjalankan dashboard, sesi dan inbox tanpa ' +
      'menghubungi Core, dan tidak pernah memutuskan permohonan. "mock" hanya untuk pengembangan; ' +
      'produksi menolak boot dengannya.',
  },
  {
    key: 'ALIM_CORE_BASE_URL',
    section: 'core',
    label: 'Alamat ALIM Core',
    kind: 'url',
    optional: true,
    help: 'Contoh: https://alim.abuhurairah.id. Wajib HTTPS di produksi.',
  },
  {
    key: 'ALIM_CORE_WEB_ORIGIN',
    section: 'core',
    label: 'Origin browser ALIM Core',
    kind: 'url',
    optional: true,
    help:
      'Satu-satunya origin yang boleh meng-embed Connect dan mengirim kode handoff. ' +
      'Harus origin saja, tanpa path. Mengosongkannya mematikan SSO dan menyempitkan iframe kembali.',
  },
  {
    key: 'ALIM_CONNECT_SSO_KEY',
    section: 'core',
    label: 'Kunci SSO (dari Core)',
    kind: 'secret',
    optional: true,
    help:
      'Harus sama persis dengan CONNECT_SSO_API_KEY di Core. Berbeda nama, satu nilai — ' +
      'menerbitkan dua nilai berbeda membuat setiap pertukaran ditolak 401.',
  },
  {
    key: 'ALIM_CORE_APPROVAL_API_KEY',
    section: 'core',
    label: 'Kunci approval (dari Core)',
    kind: 'secret',
    optional: true,
    help: 'Harus sama dengan CONNECT_APPROVAL_API_KEY di Core. Jangan diisi dengan kunci SSO yang sama.',
  },
  {
    key: 'ALIM_CONNECT_INGEST_KEY',
    section: 'core',
    label: 'Kunci masuk dari Core',
    kind: 'secret',
    optional: true,
    help:
      'Nilai yang dibuktikan Core saat mengirim permohonan ke Connect. Diterbitkan di sini dan ' +
      'diserahkan ke Core — bukan sebaliknya. Kosong berarti rute permohonan menjawab 503.',
  },

  // ── SSO handoff ────────────────────────────────────────────────────────────────────────────────
  {
    key: 'ALIM_CONNECT_SSO_AUDIENCE',
    section: 'sso',
    label: 'Audience',
    kind: 'text',
    defaultValue: 'connect',
    help: 'Nilai aud yang diminta ke Core saat pertukaran kode.',
  },
  {
    key: 'ALIM_CONNECT_SSO_SCOPE',
    section: 'sso',
    label: 'Scope',
    kind: 'text',
    defaultValue: 'whatsapp.embed',
    help: 'Scope yang harus dimiliki kode agar diterima.',
  },
  {
    key: 'ALIM_CONNECT_SSO_SESSION_TTL_HOURS',
    section: 'sso',
    label: 'Masa berlaku sesi (jam)',
    kind: 'integer',
    defaultValue: '0',
    help: '0 memakai masa berlaku sesi dashboard. Angka lain memperpendek sesi hasil handoff.',
  },
  {
    key: 'ALIM_CONNECT_SSO_TIMEOUT_MS',
    section: 'sso',
    label: 'Batas waktu ke Core (ms)',
    kind: 'integer',
    defaultValue: '5000',
    help: 'Lewat dari ini, handoff menjawab 504 dan tidak membuat sesi.',
  },
  {
    key: 'ALIM_CONNECT_SSO_API_HEADER',
    section: 'sso',
    label: 'Nama header kunci SSO',
    kind: 'text',
    defaultValue: 'X-ALIM-CONNECT-SSO-KEY',
    help: 'Ubah hanya bila Core juga mengubah CONNECT_SSO_API_HEADER. Kedua sisi harus sama.',
  },

  // ── Approval ───────────────────────────────────────────────────────────────────────────────────
  {
    key: 'ALIM_CORE_API_VERSION',
    section: 'approval',
    label: 'Versi kontrak API',
    kind: 'text',
    defaultValue: '1',
    help: 'Dikirim di X-ALIM-API-Version. Kosong berarti header tidak dikirim.',
  },
  {
    key: 'ALIM_CORE_APPROVAL_API_HEADER',
    section: 'approval',
    label: 'Nama header kunci approval',
    kind: 'text',
    defaultValue: 'X-ALIM-CONNECT-APPROVAL-KEY',
    help: 'Ubah hanya bila Core juga mengubah CONNECT_APPROVAL_API_HEADER.',
  },
  {
    key: 'ALIM_CORE_TIMEOUT_MS',
    section: 'approval',
    label: 'Batas waktu approval ke Core (ms)',
    kind: 'integer',
    defaultValue: '5000',
    help: 'Batas waktu satu permintaan keputusan ke Core.',
  },
  {
    key: 'ALIM_CONNECT_REPLY_UNKNOWN',
    section: 'approval',
    label: 'Balas nomor tak dikenal',
    kind: 'boolean',
    defaultValue: 'false',
    help: 'Membalas sembarang nomor membocorkan bahwa nomor itu terdaftar di gateway.',
  },

  // ── Retry ──────────────────────────────────────────────────────────────────────────────────────
  {
    key: 'ALIM_CONNECT_RETRY_INTERVAL_MS',
    section: 'retry',
    label: 'Interval worker retry (ms)',
    kind: 'integer',
    defaultValue: '60000',
    help: '0 mematikan worker retry sepenuhnya.',
  },
  {
    key: 'ALIM_CONNECT_RETRY_BATCH_SIZE',
    section: 'retry',
    label: 'Ukuran batch',
    kind: 'integer',
    defaultValue: '20',
    help: 'Jumlah keputusan yang dicoba ulang per putaran.',
  },
  {
    key: 'ALIM_CONNECT_RETRY_MAX_ATTEMPTS',
    section: 'retry',
    label: 'Percobaan maksimum',
    kind: 'integer',
    defaultValue: '5',
    help: 'Setelah ini, keputusan berhenti dicoba ulang.',
  },
  {
    key: 'ALIM_CONNECT_RETRY_BASE_DELAY_MS',
    section: 'retry',
    label: 'Jeda awal (ms)',
    kind: 'integer',
    defaultValue: '30000',
    help: 'Jeda sebelum percobaan berikutnya, sebelum penggandaan.',
  },
  {
    key: 'ALIM_CONNECT_RETRY_MAX_DELAY_MS',
    section: 'retry',
    label: 'Jeda maksimum (ms)',
    kind: 'integer',
    defaultValue: '900000',
    help: 'Batas atas jeda setelah penggandaan.',
  },
  {
    key: 'ALIM_CONNECT_RETRY_LEASE_MS',
    section: 'retry',
    label: 'Lease pekerjaan (ms)',
    kind: 'integer',
    defaultValue: '60000',
    help: 'Seberapa lama satu pekerjaan retry dipegang sebelum boleh diambil proses lain.',
  },
];

export const SECRET_KEYS: readonly string[] = ALIM_CORE_FIELDS.filter(field => field.kind === 'secret').map(
  field => field.key,
);

/**
 * Normalises a submitted value for one field, or explains why it cannot be stored.
 *
 * Whitespace is trimmed for every kind — a key pasted with a trailing newline is a different key to
 * Core, and the failure it causes (401) is indistinguishable from a wrong key. Validation happens
 * before anything is written so a half-saved integration cannot exist.
 */
export function normalizeFieldValue(
  field: AlimCoreFieldSpec,
  raw: string,
  nodeEnv?: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.trim();

  if (value === '') {
    return field.optional ? { ok: true, value: '' } : { ok: false, message: `${field.label} tidak boleh kosong.` };
  }

  switch (field.kind) {
    case 'url': {
      // `parseCoreWebOrigin` accepts http: for a loopback development host, which is right for the
      // boot gate but wrong here: the settings page is where a production operator types the address,
      // and `http://` would send the SSO key across the network in clear text. Refused before it is
      // stored rather than discovered at the first refused handoff.
      if (nodeEnv === 'production' && !value.toLowerCase().startsWith('https://')) {
        return { ok: false, message: `${field.label} harus diawali https:// di produksi.` };
      }
      const origin = parseCoreWebOrigin(value);
      if (!origin) {
        return {
          ok: false,
          message: `${field.label} harus URL https:// tanpa path, tanpa wildcard, dan tanpa kredensial.`,
        };
      }
      return { ok: true, value: origin };
    }
    case 'enum':
      if (!field.choices?.includes(value)) {
        return { ok: false, message: `${field.label} harus salah satu dari: ${field.choices?.join(', ')}.` };
      }
      return { ok: true, value };
    case 'integer': {
      if (!/^\d+$/.test(value)) {
        return { ok: false, message: `${field.label} harus bilangan bulat nol atau lebih.` };
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) {
        return { ok: false, message: `${field.label} terlalu besar.` };
      }
      return { ok: true, value: String(parsed) };
    }
    case 'boolean':
      if (value !== 'true' && value !== 'false') {
        return { ok: false, message: `${field.label} harus true atau false.` };
      }
      return { ok: true, value };
    case 'secret':
    case 'text':
      return { ok: true, value };
  }
}

/**
 * The one refusal that is about the combination rather than any single field.
 *
 * Production refuses to boot on `mock`, and refuses `http` without an address and a key. Detecting it
 * here means the person who just chose the wrong option is told why, instead of the save succeeding
 * and the next restart taking the site down.
 *
 * `submitted` is what this save touches, and the rule is judged only when the save actually selects a
 * mode. Filling in a key before choosing a mode is a legitimate, partial configuration — refusing it
 * would force the operator to guess an order for fields the page does not impose one on. The boot
 * gate still refuses `mock` when the effective value really is `mock`, so nothing is made lazier.
 */
export function crossFieldProblem(
  values: Record<string, string>,
  nodeEnv: string | undefined,
  submitted: Record<string, string> = values,
): string | null {
  if (nodeEnv !== 'production') {
    return null;
  }
  if (!('ALIM_CONNECT_CORE_CLIENT' in submitted)) {
    return null;
  }

  const mode = resolveApprovalCoreClient(values.ALIM_CONNECT_CORE_CLIENT);
  if (mode === 'mock') {
    return (
      'Mode "mock" ditolak di produksi: ia dapat menandai permohonan disetujui tanpa persetujuan ALIM Core. ' +
      'Pilih "http" bila integrasi Core sudah aktif, atau "disabled" bila belum.'
    );
  }
  if (mode === 'http') {
    const missing = [
      values.ALIM_CORE_BASE_URL?.trim() ? null : 'Alamat ALIM Core',
      values.ALIM_CORE_APPROVAL_API_KEY?.trim() ? null : 'Kunci approval',
    ].filter((item): item is string => item !== null);
    if (missing.length > 0) {
      return `Mode "http" membutuhkan ${missing.join(' dan ')}.`;
    }
  }
  return null;
}
