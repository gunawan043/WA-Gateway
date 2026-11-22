import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { HttpAlimCoreApprovalClient } from '../../../src/modules/approval/core-client/http-alim-core-approval.client';
import type { CoreApprovalCommand } from '../../../src/modules/approval/core-client/alim-core-approval.client';
import {
  APPROVAL_COMMAND_PATH,
  MOCK_API_KEY,
  MOCK_PERMIT_ID,
  startMockApprovalCore,
  type MockApprovalHandle,
} from './approval-command.mock';
import { createSchemaTools, type ContractDoc } from './schema-validator';

/**
 * Uji kontrak Approval Command.
 *
 * Berbeda dari `contract.spec.ts` (kontrak master read-only), lane ini menjaga satu
 * endpoint tulis yang benar-benar dipakai Connect. Tiga hal dibuktikan:
 *
 * 1. Dokumen kontrak jujur: satu operasi `POST`, provisional, menyebut yang masih
 *    menunggu Core, dan **tidak** menyentuh `connect-v1.openapi.yaml`.
 * 2. Mock meniru Core sebenarnya, termasuk envelope middleware (`errors: null`),
 *    validasi FormRequest, dan semantik idempotensi `command_id` +
 *    `external_message_id`.
 * 3. Klien HTTP Connect yang asli memetakan jawaban itu dengan benar — termasuk
 *    timeout yang **tidak** boleh disimpulkan sebagai keputusan.
 *
 * Tidak ada koneksi ke ALIM Core. Satu-satunya server adalah mock lokal.
 */

const contractPath = join(__dirname, 'approval-command.openapi.yaml');
const doc = yaml.load(readFileSync(contractPath, 'utf8')) as ContractDoc;
const { schemas, expectValid } = createSchemaTools(doc);

const collectRefs = (value: unknown, refs: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof child === 'string') refs.push(child);
      else collectRefs(child, refs);
    }
  }
  return refs;
};

const validCommand = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  command_id: 'cmd-0001',
  request_id: MOCK_PERMIT_ID,
  decision: 'approved',
  approved_duration_days: 2,
  actor_external_id: '628123456789',
  actor_core_person_id: null,
  source: 'whatsapp',
  external_message_id: 'wamid.in.0001',
  message_text: 'SETUJU 2 HARI IZN-2026-00125',
  notes: null,
  ...overrides,
});

describe('kontrak Approval Command: dokumen', () => {
  it('menyatakan dirinya draf OpenAPI 3.1 yang provisional', () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info?.version).toContain('draft');
    expect(doc.info?.['x-contract-status']).toBe('provisional');
  });

  it('memuat tepat satu operasi POST pada /approval-commands', () => {
    const paths = Object.entries(doc.paths ?? {});
    expect(paths.map(([path]) => path)).toEqual(['/approval-commands']);

    const item = doc.paths?.['/approval-commands'];
    expect(item).toBeDefined();
    const methods = Object.keys(item as Record<string, unknown>).filter(
      key => key !== 'summary' && key !== 'description',
    );
    expect(methods).toEqual(['post']);
  });

  it('menandai operasi provisional dan menyebut apa yang menunggu Core', () => {
    const operation = doc.paths?.['/approval-commands']?.post;
    expect(operation?.['x-contract-status']).toBe('provisional');
    expect(typeof operation?.operationId).toBe('string');

    const pending = operation?.['x-needs-core-confirmation'];
    expect(Array.isArray(pending)).toBe(true);
    expect((pending as unknown[]).length).toBeGreaterThan(0);
  });

  it('mendeklarasikan autentikasi key khusus Connect di header', () => {
    const scheme = doc.components?.securitySchemes?.['connectApprovalKey'] as Record<string, unknown> | undefined;
    expect(scheme).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'X-ALIM-CONNECT-APPROVAL-KEY',
    });
  });

  it('menyelesaikan setiap $ref', () => {
    const refs = [...new Set(collectRefs(doc))];
    expect(refs.length).toBeGreaterThan(5);

    const unresolved = refs.filter(ref => {
      const [group, name] = ref.replace('#/components/', '').split('/');
      const bucket = (doc.components as Record<string, Record<string, unknown> | undefined>)[group];
      return bucket?.[name] === undefined;
    });

    expect(unresolved).toEqual([]);
  });

  it('tidak menyentuh kontrak master read-only', () => {
    const master = readFileSync(join(__dirname, 'connect-v1.openapi.yaml'), 'utf8');

    // Endpoint command tidak boleh muncul di dokumen read-only.
    expect(master).not.toContain('approval-commands');
    // Dan dokumen read-only tetap hanya GET.
    for (const method of ['post:', 'put:', 'patch:', 'delete:']) {
      expect(master).not.toMatch(new RegExp(`^\\s{4}${method}`, 'm'));
    }
  });

  it('menetapkan field wajib yang sama dengan validasi Core', () => {
    const request = schemas['ApprovalCommandRequest'];
    expect(new Set(request.required)).toEqual(
      new Set(['command_id', 'request_id', 'decision', 'actor_external_id', 'source', 'external_message_id']),
    );
    expect(request.properties?.['decision']?.enum).toEqual([
      'approved',
      'rejected',
      'needs_clarification',
      'expired',
      'cancelled',
    ]);
    expect(request.properties?.['source']?.enum).toEqual(['whatsapp']);
    expect(request.additionalProperties).toBe(false);
  });
});

describe('kontrak Approval Command: fixture', () => {
  it('menerima command setuju yang lengkap', () => {
    expectValid(validCommand(), schemas['ApprovalCommandRequest'], 'command');
  });

  it('menerima command tolak tanpa durasi', () => {
    expectValid(
      validCommand({ decision: 'rejected', approved_duration_days: null, message_text: 'TOLAK IZN-2026-00125' }),
      schemas['ApprovalCommandRequest'],
      'command',
    );
  });

  it.each(['needs_clarification', 'expired', 'cancelled'])('menerima decision non-final %s tanpa durasi', decision => {
    expectValid(
      validCommand({ decision, approved_duration_days: null, message_text: null }),
      schemas['ApprovalCommandRequest'],
      'command',
    );
  });

  it('menolak durasi di luar batas kontrak', () => {
    const errors: string[] = [];
    const { validate } = createSchemaTools(doc);
    validate(validCommand({ approved_duration_days: 366 }), schemas['ApprovalCommandRequest'], 'command', errors);

    expect(errors.some(message => message.includes('366'))).toBe(true);
  });

  it('menerima envelope sukses dan envelope error Core', () => {
    expectValid(
      {
        success: true,
        message: 'Keputusan izin tersimpan.',
        data: {
          outcome: 'applied',
          duplicate: false,
          command_id: 'cmd-0001',
          request_id: MOCK_PERMIT_ID,
          decision: 'approved',
          status: 'approved',
          secondary_status: null,
          approved_duration_days: 2,
          departure_datetime: '2026-11-24T01:00:00+07:00',
          expected_return_datetime: '2026-11-26T01:00:00+07:00',
          decided_at: '2026-11-22T06:00:00+00:00',
          actor: { core_person_id: '22222222-2222-4222-8222-222222222222', name: 'Kepala Asrama' },
          source: 'whatsapp',
          external_message_id: 'wamid.in.0001',
          message_text: 'SETUJU 2 HARI IZN-2026-00125',
        },
        meta: { timestamp: '2026-11-22T06:00:00+00:00' },
        errors: null,
      },
      schemas['ApprovalCommandSuccess'],
      'success',
    );

    expectValid(
      {
        success: false,
        message: 'Payload command tidak valid.',
        data: null,
        meta: { timestamp: '2026-11-22T06:00:00+00:00' },
        errors: { code: 'validation_failed', context: { command_id: ['wajib diisi'] } },
      },
      schemas['ApprovalCommandError'],
      'error',
    );

    // Middleware Core mengirim `errors: null`; kontrak harus menerimanya.
    expectValid(
      {
        success: false,
        message: 'API key tidak valid atau tidak dikirim.',
        data: null,
        meta: { timestamp: '2026-11-22T06:00:00+00:00' },
        errors: null,
      },
      schemas['ApprovalCommandError'],
      'middleware-error',
    );
  });
});

describe('kontrak Approval Command: mock meniru Core', () => {
  let mock: MockApprovalHandle;

  beforeEach(async () => {
    mock = await startMockApprovalCore();
  });

  afterEach(async () => {
    await mock.close();
  });

  const post = (body: Record<string, unknown>, key = MOCK_API_KEY, method = 'POST'): Promise<Response> =>
    fetch(`${mock.url}${APPROVAL_COMMAND_PATH}`, {
      method,
      headers: { 'content-type': 'application/json', 'X-ALIM-CONNECT-APPROVAL-KEY': key },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });

  it('menerapkan keputusan dan mengembalikan envelope Core', async () => {
    const response = await post(validCommand());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(response.headers.get('pragma')).toBe('no-cache');

    const body = (await response.json()) as Record<string, unknown>;
    expectValid(body, schemas['ApprovalCommandSuccess'], 'GET applied');
    expect(mock.appliedCount()).toBe(1);
  });

  it('menghitung perkiraan kembali dari keberangkatan + durasi', async () => {
    const body = (await (await post(validCommand({ approved_duration_days: 3 }))).json()) as {
      data: { expected_return_datetime: string; departure_datetime: string };
    };

    expect(Date.parse(body.data.expected_return_datetime) - Date.parse(body.data.departure_datetime)).toBe(
      3 * 24 * 60 * 60 * 1000,
    );
  });

  it('mengembalikan keputusan non-final tanpa mengubah status izin', async () => {
    const response = await post(
      validCommand({ decision: 'needs_clarification', approved_duration_days: null, message_text: null }),
    );
    const body = (await response.json()) as {
      data: { outcome: string; status: string; secondary_status: string | null };
    };

    expect(response.status).toBe(200);
    expect(body.data.outcome).toBe('needs_clarification');
    expect(body.data.status).toBe('pending');
    expect(body.data.secondary_status).toBe('needs_clarification');
    expect(mock.appliedCount()).toBe(0);
  });

  it('mengembalikan duplicate untuk command_id yang sama tanpa menerapkan dua kali', async () => {
    const command = validCommand();
    await post(command);

    const replay = await post(command);
    const body = (await replay.json()) as { data: { outcome: string; duplicate: boolean } };

    expect(replay.status).toBe(200);
    expect(body.data.outcome).toBe('duplicate');
    expect(body.data.duplicate).toBe(true);
    expect(mock.appliedCount()).toBe(1);
  });

  it('menolak command_id yang dipakai ulang dengan payload berbeda', async () => {
    await post(validCommand());

    const response = await post(validCommand({ approved_duration_days: 5 }));
    const body = (await response.json()) as { errors: { code: string } };

    expect(response.status).toBe(409);
    expect(body.errors.code).toBe('command_id_reused');
    expect(mock.appliedCount()).toBe(1);
  });

  it('menolak external_message_id yang sudah menjadi command lain', async () => {
    await post(validCommand());

    const response = await post(validCommand({ command_id: 'cmd-0002' }));
    const body = (await response.json()) as { errors: { code: string } };

    expect(response.status).toBe(409);
    expect(body.errors.code).toBe('external_message_replayed');
    expect(mock.appliedCount()).toBe(1);
  });

  it('menolak SETUJU tanpa durasi sebagai validation_failed', async () => {
    const response = await post(validCommand({ approved_duration_days: null }));
    const body = (await response.json()) as { errors: { code: string; context: Record<string, unknown> } };

    expect(response.status).toBe(422);
    expect(body.errors.code).toBe('validation_failed');
    expect(body.errors.context).toHaveProperty('approved_duration_days');
    expect(mock.appliedCount()).toBe(0);
  });

  it('menolak TOLAK yang membawa durasi', async () => {
    const response = await post(validCommand({ decision: 'rejected', approved_duration_days: 2 }));

    expect(response.status).toBe(422);
    expect(mock.appliedCount()).toBe(0);
  });

  it('menolak key yang salah tanpa membocorkan isi key', async () => {
    const response = await post(validCommand(), 'wrong-key');
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).not.toContain(MOCK_API_KEY);
    expect(mock.appliedCount()).toBe(0);
  });

  it('menolak key tanpa cakupan approval:command', async () => {
    const scoped = await startMockApprovalCore({ scopes: ['organization:read'] });

    try {
      const response = await fetch(`${scoped.url}${APPROVAL_COMMAND_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-ALIM-CONNECT-APPROVAL-KEY': MOCK_API_KEY },
        body: JSON.stringify(validCommand()),
      });
      const body = (await response.json()) as { errors: { code: string } };

      expect(response.status).toBe(403);
      expect(body.errors.code).toBe('insufficient_scope');
    } finally {
      await scoped.close();
    }
  });

  it('meneruskan penolakan bisnis Core apa adanya', async () => {
    mock.setScenario('permit_not_decidable');

    const response = await post(validCommand());
    const body = (await response.json()) as { errors: { code: string } };

    expect(response.status).toBe(409);
    expect(body.errors.code).toBe('permit_not_decidable');
    expect(mock.appliedCount()).toBe(0);
  });

  it('melaporkan 503 tanpa envelope error terstruktur saat Core tidak tersedia', async () => {
    mock.setScenario('server_error');

    const response = await post(validCommand());
    const body = (await response.json()) as { errors: unknown };

    expect(response.status).toBe(503);
    expect(body.errors).toBeNull();
  });

  it('menolak metode selain POST', async () => {
    const response = await post({}, MOCK_API_KEY, 'GET');

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('kontrak Approval Command: klien Connect terhadap mock', () => {
  let mock: MockApprovalHandle;
  let client: HttpAlimCoreApprovalClient;
  let timeoutMs: number;

  const command = (overrides: Partial<CoreApprovalCommand> = {}): CoreApprovalCommand => ({
    commandId: 'cmd-client-1',
    requestId: MOCK_PERMIT_ID,
    decision: 'approved',
    approvedDurationDays: 2,
    actorExternalId: '628123456789',
    actorCorePersonId: null,
    source: 'whatsapp',
    externalMessageId: 'wamid.in.1',
    messageText: 'SETUJU 2 HARI IZN-2026-00125',
    notes: null,
    ...overrides,
  });

  beforeEach(async () => {
    mock = await startMockApprovalCore();
    timeoutMs = 5000;
    const config = {
      get: (key: string, fallback?: unknown) => {
        if (key === 'connect.approval.coreBaseUrl') return mock.url;
        if (key === 'connect.approval.coreApiKey') return MOCK_API_KEY;
        if (key === 'connect.approval.coreApiHeader') return 'X-ALIM-CONNECT-APPROVAL-KEY';
        if (key === 'connect.approval.timeoutMs') return timeoutMs;
        return fallback;
      },
    };
    client = new HttpAlimCoreApprovalClient(config as never);
  });

  afterEach(async () => {
    await mock.close();
  });

  it('mengirim payload snake_case yang sama dengan kontrak', async () => {
    await client.sendApprovalCommand(command());

    expect(Object.keys(mock.received[0]).sort()).toEqual(
      [
        'actor_core_person_id',
        'actor_external_id',
        'approved_duration_days',
        'command_id',
        'decision',
        'external_message_id',
        'message_text',
        'notes',
        'request_id',
        'source',
      ].sort(),
    );
  });

  it('memetakan sukses menjadi applied beserta status izin Core', async () => {
    const result = await client.sendApprovalCommand(command());

    expect(result.outcome).toBe('applied');
    expect(result.coreStatus).toBe('approved');
    expect(result.expectedReturnAt).not.toBeNull();
    expect(result.retryable).toBe(false);
  });

  it('memetakan replay menjadi duplicate, bukan applied kedua', async () => {
    await client.sendApprovalCommand(command());
    const replay = await client.sendApprovalCommand(command());

    expect(replay.outcome).toBe('duplicate');
    expect(mock.appliedCount()).toBe(1);
  });

  it('memetakan penolakan otorisasi menjadi rejected beserta kodenya', async () => {
    mock.setScenario('actor_not_authorized');
    const result = await client.sendApprovalCommand(command());

    expect(result.outcome).toBe('rejected');
    expect(result.code).toBe('actor_not_authorized');
    expect(result.httpStatus).toBe(403);
    expect(result.retryable).toBe(false);
  });

  it('tidak menyimpulkan keputusan saat timeout, dan retry aman dengan commandId yang sama', async () => {
    mock.setDelay(300);
    timeoutMs = 40;

    const timedOut = await client.sendApprovalCommand(command());

    expect(timedOut.outcome).toBe('unavailable');
    expect(timedOut.code).toBe('core_timeout');
    expect(timedOut.retryable).toBe(true);
    expect(timedOut.coreStatus).toBeNull();

    mock.setDelay(0);
    const retried = await client.sendApprovalCommand(command());

    expect(retried.outcome).toBe('duplicate');
    expect(mock.appliedCount()).toBe(1);
  });

  it('memetakan 503 menjadi unavailable yang boleh diulang', async () => {
    mock.setScenario('server_error');
    const result = await client.sendApprovalCommand(command());

    expect(result.outcome).toBe('unavailable');
    expect(result.httpStatus).toBe(503);
    expect(result.retryable).toBe(true);
  });

  it('melaporkan core_not_configured tanpa mencoba jaringan', async () => {
    const unconfigured = new HttpAlimCoreApprovalClient({ get: () => '' } as never);
    const result = await unconfigured.sendApprovalCommand(command());

    expect(result.outcome).toBe('unavailable');
    expect(result.code).toBe('core_not_configured');
    expect(result.retryable).toBe(false);
  });
});
