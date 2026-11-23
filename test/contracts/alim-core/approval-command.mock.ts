import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Mock ALIM Core untuk Approval Command API.
 *
 * Server ini meniru **respons Core yang sebenarnya**, bukan bentuk yang diinginkan Connect:
 * envelope `{success, message, data, meta, errors}`, `errors` bisa `null` (middleware) atau
 * `{code, context}` (controller), `data.status` memakai nama status izin Core, dan
 * `expected_return_datetime` dihitung dari keberangkatan + durasi.
 *
 * Yang tidak dimodelkan: database, otorisasi nyata, dan audit Core. Yang dijaga justru
 * semantik idempotensi (`command_id`, `external_message_id`) karena di situlah kesalahan
 * integrasi paling mahal: satu pesan WhatsApp menjadi dua keputusan.
 */

export const APPROVAL_COMMAND_PATH = '/api/connect/v1/approval-commands';

export type MockApprovalScenario =
  | 'applied'
  | 'duplicate'
  | 'validation_failed'
  | 'actor_not_authorized'
  | 'permit_not_decidable'
  | 'external_message_replayed'
  | 'unauthorized'
  | 'insufficient_scope'
  | 'server_error';

export interface MockApprovalOptions {
  /** Key yang diterima. Default `approval-contract-key`. */
  apiKey?: string;
  /** Cakupan yang dimiliki key. Default `['approval:command']`. */
  scopes?: string[];
  /** Perilaku yang dipaksa untuk request berikutnya. `null` = perilaku Core normal. */
  scenario?: MockApprovalScenario | null;
  /** Jeda sebelum membalas, untuk menguji timeout Connect. Keputusan tetap tercatat. */
  delayMs?: number;
}

export interface MockApprovalHandle {
  url: string;
  /** Semua command yang diterima, termasuk yang akhirnya duplikat. */
  received: Array<Record<string, unknown>>;
  /** Header tiap request, sejajar dengan `received`. */
  receivedHeaders: Array<IncomingMessage['headers']>;
  /** Berapa kali Core benar-benar mengubah status izin. Harus tetap 1 pada replay. */
  appliedCount: () => number;
  setScenario: (scenario: MockApprovalScenario | null) => void;
  setDelay: (delayMs: number) => void;
  close: () => Promise<void>;
}

interface RecordedDecision {
  request: Record<string, unknown>;
  body: Record<string, unknown>;
}

const DEFAULT_API_KEY = 'approval-contract-key';
const PERMIT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const DEPARTURE = '2026-11-24T01:00:00+07:00';

const iso = (): string => new Date().toISOString();

const envelope = (
  success: boolean,
  message: string,
  data: Record<string, unknown> | null,
  errors: Record<string, unknown> | null,
): Record<string, unknown> => ({
  success,
  message,
  data,
  meta: { timestamp: iso() },
  errors,
});

/** Envelope middleware Core: `errors` selalu `null`. */
const middlewareError = (message: string, status: number): { status: number; body: Record<string, unknown> } => ({
  status,
  body: envelope(false, message, null, null),
});

const addDays = (days: number): string => {
  const base = new Date(DEPARTURE);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString();
};

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');

  if (text.trim() === '') {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const DECISION_VALUES = ['approved', 'rejected', 'needs_clarification', 'expired', 'cancelled'] as const;

const validate = (payload: Record<string, unknown>): Record<string, string[]> | null => {
  const errors: Record<string, string[]> = {};
  const string = (key: string, max: number): void => {
    const value = payload[key];
    if (typeof value !== 'string' || value.trim() === '') errors[key] = ['wajib diisi'];
    else if (value.length > max) errors[key] = [`maksimal ${max} karakter`];
  };

  string('command_id', 100);
  string('request_id', 36);
  string('actor_external_id', 191);
  string('external_message_id', 191);

  if (typeof payload['request_id'] === 'string' && !/^[0-9a-f-]{36}$/i.test(payload['request_id'])) {
    errors['request_id'] = ['harus UUID'];
  }

  if (
    typeof payload['decision'] !== 'string' ||
    !(DECISION_VALUES as readonly string[]).includes(payload['decision'])
  ) {
    errors['decision'] = [`harus salah satu dari ${DECISION_VALUES.join(', ')}`];
  }

  if (payload['source'] !== 'whatsapp') {
    errors['source'] = ['harus whatsapp'];
  }

  const days = payload['approved_duration_days'];

  if (payload['decision'] === 'approved') {
    if (typeof days !== 'number' || !Number.isInteger(days)) {
      errors['approved_duration_days'] = ['wajib berupa bilangan bulat hari'];
    } else if (days < 1 || days > 365) {
      errors['approved_duration_days'] = ['harus antara 1 dan 365'];
    }
  } else if (payload['decision'] === 'rejected') {
    if (days !== undefined && days !== null) {
      errors['approved_duration_days'] = ['tidak boleh dikirim untuk keputusan rejected'];
    }
  } else if (days !== undefined && days !== null) {
    // Core menerima kolom ini opsional untuk tiga nilai non-final, tetapi Connect tidak pernah
    // mengirimnya; mock menolak agar selisih kontrak terlihat.
    errors['approved_duration_days'] = ['hanya untuk keputusan approved'];
  }

  return Object.keys(errors).length === 0 ? null : errors;
};

export const startMockApprovalCore = async (options: MockApprovalOptions = {}): Promise<MockApprovalHandle> => {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const scopes = options.scopes ?? ['approval:command'];
  const received: Array<Record<string, unknown>> = [];
  const receivedHeaders: Array<IncomingMessage['headers']> = [];
  const decided = new Map<string, RecordedDecision>();
  const messageIds = new Map<string, string>();
  let applied = 0;
  let scenario: MockApprovalScenario | null = options.scenario ?? null;
  let delayMs = options.delayMs ?? 0;

  const apply = (payload: Record<string, unknown>): Record<string, unknown> => {
    const decision = payload['decision'] as string;
    const isFinal = decision === 'approved' || decision === 'rejected';
    const days = decision === 'approved' ? (payload['approved_duration_days'] as number) : null;
    const decidedAt = iso();

    // Hanya keputusan final yang mengubah status izin; tiga nilai non-final mempertahankan
    // `pending` dan hanya mengisi `secondary_status`, sama seperti Core.
    if (isFinal) {
      applied += 1;
    }

    return {
      outcome: isFinal ? 'applied' : decision,
      duplicate: false,
      command_id: payload['command_id'],
      request_id: payload['request_id'],
      decision,
      status: decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'pending',
      secondary_status: isFinal ? null : decision,
      approved_duration_days: days,
      departure_datetime: DEPARTURE,
      expected_return_datetime: days === null ? null : addDays(days),
      decided_at: decidedAt,
      actor: { core_person_id: ACTOR_ID, name: 'Kepala Asrama' },
      source: payload['source'],
      external_message_id: payload['external_message_id'],
      message_text: payload['message_text'] ?? null,
    };
  };

  const handle = (
    payload: Record<string, unknown>,
    headers: IncomingMessage['headers'],
  ): { status: number; body: Record<string, unknown> } => {
    received.push(payload);
    receivedHeaders.push(headers);

    // ── Cakupan key (subclass middleware) ────────────────────────────────
    if (!scopes.includes('approval:command')) {
      return {
        status: 403,
        body: envelope(false, 'API key ini tidak memiliki cakupan approval:command.', null, {
          code: 'insufficient_scope',
        }),
      };
    }

    // ── Autentikasi (middleware) ─────────────────────────────────────────
    const provided = headers['x-alim-connect-approval-key'] ?? (headers.authorization ?? '').replace(/^Bearer\s+/i, '');

    if (typeof provided !== 'string' || provided === '' || provided !== apiKey) {
      return middlewareError('API key tidak valid atau tidak dikirim.', 401);
    }

    if (scenario === 'unauthorized') {
      return middlewareError('API key tidak valid atau tidak dikirim.', 401);
    }

    // ── Validasi bentuk (FormRequest) ────────────────────────────────────
    const invalid = validate(payload);

    if (invalid !== null || scenario === 'validation_failed') {
      return {
        status: 422,
        body: envelope(false, 'Payload command tidak valid.', null, {
          code: 'validation_failed',
          context: invalid ?? { command_id: ['dipaksa gagal oleh skenario'] },
        }),
      };
    }

    // ── Idempotensi command_id ───────────────────────────────────────────
    const previous = decided.get(payload['command_id'] as string);

    if (previous) {
      const samePayload = JSON.stringify(previous.request) === JSON.stringify(payload);

      if (!samePayload) {
        return {
          status: 409,
          body: envelope(false, 'command_id sudah dipakai untuk payload yang berbeda.', null, {
            code: 'command_id_reused',
            context: { command_id: payload['command_id'] },
          }),
        };
      }

      return {
        status: 200,
        body: envelope(
          true,
          'Command ini sudah pernah diproses.',
          { ...previous.body, outcome: 'duplicate', duplicate: true },
          null,
        ),
      };
    }

    // ── Idempotensi external_message_id ──────────────────────────────────
    const messageOwner = messageIds.get(payload['external_message_id'] as string);

    if (messageOwner !== undefined || scenario === 'external_message_replayed') {
      return {
        status: 409,
        body: envelope(false, 'Pesan eksternal ini sudah diproses untuk command lain.', null, {
          code: 'external_message_replayed',
          context: { command_id: messageOwner ?? 'other-command' },
        }),
      };
    }

    if (scenario === 'actor_not_authorized') {
      return {
        status: 403,
        body: envelope(false, 'Aktor bukan Kepala Asrama aktif pada asrama permohonan ini.', null, {
          code: 'actor_not_authorized',
          context: {},
        }),
      };
    }

    if (scenario === 'permit_not_decidable') {
      return {
        status: 409,
        body: envelope(false, 'Permohonan sudah diputuskan atau tidak lagi dapat diputuskan.', null, {
          code: 'permit_not_decidable',
          context: { status: 'approved' },
        }),
      };
    }

    if (scenario === 'server_error') {
      return {
        status: 503,
        body: envelope(false, 'Core sedang tidak tersedia.', null, null),
      };
    }

    if (scenario === 'duplicate') {
      // Skenario ini meniru Core yang sudah memproses command lalu menerima replay.
      const body = apply(payload);
      decided.set(payload['command_id'] as string, { request: payload, body });
      messageIds.set(payload['external_message_id'] as string, payload['command_id'] as string);

      // `apply` hanya menambah penghitung untuk keputusan final; skenario duplikat berarti
      // keputusan itu sudah dihitung pada pengiriman pertama.
      if (body.outcome === 'applied') {
        applied -= 1;
      }

      return {
        status: 200,
        body: envelope(
          true,
          'Command ini sudah pernah diproses.',
          { ...body, outcome: 'duplicate', duplicate: true },
          null,
        ),
      };
    }

    // ── Terapkan ─────────────────────────────────────────────────────────
    const body = apply(payload);
    decided.set(payload['command_id'] as string, { request: payload, body });
    messageIds.set(payload['external_message_id'] as string, payload['command_id'] as string);

    return { status: 200, body: envelope(true, 'Keputusan izin tersimpan.', body, null) };
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.url !== APPROVAL_COMMAND_PATH) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify(envelope(false, 'Not found.', null, null)));
        return;
      }

      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        response.end(JSON.stringify(envelope(false, 'Method not allowed.', null, null)));
        return;
      }

      const payload = await readBody(request);
      const result = handle(payload, request.headers);

      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      response.writeHead(result.status, {
        'content-type': 'application/json',
        'cache-control': 'no-store, private',
        pragma: 'no-cache',
      });
      response.end(JSON.stringify(result.body));
    })().catch(() => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify(envelope(false, 'Mock failure.', null, null)));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Mock Core tidak mendapat port.');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    receivedHeaders,
    appliedCount: () => applied,
    setScenario: next => {
      scenario = next;
    },
    setDelay: next => {
      delayMs = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
};

export const mockRequestId = (): string => randomUUID();
export const MOCK_PERMIT_ID = PERMIT_ID;
export const MOCK_ACTOR_ID = ACTOR_ID;
export const MOCK_API_KEY = DEFAULT_API_KEY;
