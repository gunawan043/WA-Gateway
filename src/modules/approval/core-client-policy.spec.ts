import { ConfigService } from '@nestjs/config';
import { ApprovalCoreClientConfigError, assertApprovalCoreClientAllowed } from './core-client/core-client-policy';
import { createApprovalCoreClient } from './approval.module';
import { MockAlimCoreApprovalClient } from './core-client/mock-alim-core-approval.client';
import { DisabledAlimCoreApprovalClient } from './core-client/disabled-alim-core-approval.client';
import { HttpAlimCoreApprovalClient } from './core-client/http-alim-core-approval.client';

/**
 * Pemilihan klien Core berjalan pada jalur startup (`useFactory`), jadi yang diuji di sini adalah
 * fungsi yang benar-benar dipanggil Nest saat boot — bukan salinan logikanya.
 */
describe('Kebijakan klien ALIM Core', () => {
  const http = { name: 'http' } as unknown as HttpAlimCoreApprovalClient;
  const mock = { name: 'mock' } as unknown as MockAlimCoreApprovalClient;
  const disabled = { name: 'disabled' } as unknown as DisabledAlimCoreApprovalClient;

  const configFor = (values: Record<string, string>): ConfigService =>
    ({
      get: (key: string, fallback?: string) => values[key] ?? fallback,
    }) as unknown as ConfigService;

  describe('assertApprovalCoreClientAllowed', () => {
    it('menolak mock di produksi', () => {
      expect(() =>
        assertApprovalCoreClientAllowed({ coreClient: 'mock', coreBaseUrl: '', coreApiKey: '' }, 'production'),
      ).toThrow(ApprovalCoreClientConfigError);
    });

    it('menolak pilihan klien yang tidak dikenal di produksi (bukan hanya "mock")', () => {
      expect(() =>
        assertApprovalCoreClientAllowed({ coreClient: '', coreBaseUrl: '', coreApiKey: '' }, 'production'),
      ).toThrow(/ALIM_CONNECT_CORE_CLIENT harus "http" atau "disabled" di produksi/);
    });

    it('menolak klien HTTP tanpa alamat atau kunci di produksi, dan menyebut variabel yang kurang', () => {
      expect(() =>
        assertApprovalCoreClientAllowed({ coreClient: 'http', coreBaseUrl: '', coreApiKey: 'k' }, 'production'),
      ).toThrow(/ALIM_CORE_BASE_URL/);

      expect(() =>
        assertApprovalCoreClientAllowed(
          { coreClient: 'http', coreBaseUrl: 'https://core.example', coreApiKey: '  ' },
          'production',
        ),
      ).toThrow(/ALIM_CORE_APPROVAL_API_KEY/);

      expect(() =>
        assertApprovalCoreClientAllowed({ coreClient: 'http', coreBaseUrl: '', coreApiKey: '' }, 'production'),
      ).toThrow(/ALIM_CORE_BASE_URL dan ALIM_CORE_APPROVAL_API_KEY/);
    });

    it('menerima klien HTTP yang lengkap di produksi', () => {
      expect(() =>
        assertApprovalCoreClientAllowed(
          { coreClient: 'http', coreBaseUrl: 'https://core.example', coreApiKey: 'k' },
          'production',
        ),
      ).not.toThrow();
    });

    // The architectural requirement: ALIM Connect must run on its own, so the deliberate opt-out
    // has to pass in production even with no Core URL and no key.
    it('menerima "disabled" di produksi meski tanpa alamat dan kunci Core', () => {
      expect(() =>
        assertApprovalCoreClientAllowed({ coreClient: 'disabled', coreBaseUrl: '', coreApiKey: '' }, 'production'),
      ).not.toThrow();
    });

    it('menerima "disabled" tanpa memandang huruf besar/kecil dan spasi', () => {
      for (const value of ['disabled', 'DISABLED', ' Disabled ']) {
        expect(() =>
          assertApprovalCoreClientAllowed({ coreClient: value, coreBaseUrl: '', coreApiKey: '' }, 'production'),
        ).not.toThrow();
      }
    });

    // A typo must never be read as "disabled": only the exact word opts out.
    it('tidak memperlakukan salah ketik sebagai disabled', () => {
      for (const value of ['disable', 'off', 'none', 'false', '']) {
        expect(() =>
          assertApprovalCoreClientAllowed({ coreClient: value, coreBaseUrl: '', coreApiKey: '' }, 'production'),
        ).toThrow(ApprovalCoreClientConfigError);
      }
    });

    it('tetap mengizinkan mock di luar produksi (development dan testing)', () => {
      for (const env of ['development', 'test', undefined]) {
        expect(() =>
          assertApprovalCoreClientAllowed({ coreClient: 'mock', coreBaseUrl: '', coreApiKey: '' }, env),
        ).not.toThrow();
      }
    });
  });

  describe('createApprovalCoreClient', () => {
    it('mengembalikan mock saat konfigurasi kosong di luar produksi', () => {
      expect(createApprovalCoreClient(configFor({}), mock, http, disabled)).toBe(mock);
    });

    it('mengembalikan klien HTTP saat dikonfigurasi', () => {
      const config = configFor({
        'connect.approval.coreClient': 'http',
        'connect.approval.coreBaseUrl': 'https://core.example',
        'connect.approval.coreApiKey': 'k',
      });

      expect(createApprovalCoreClient(config, mock, http, disabled)).toBe(http);
    });

    it('mengembalikan klien disabled saat integrasi dimatikan, BUKAN mock', () => {
      const config = configFor({ 'connect.approval.coreClient': 'disabled' });

      // The distinction matters: mock answers `applied`, which would confirm an approval to the
      // Head of Dormitory that Core never made.
      expect(createApprovalCoreClient(config, mock, http, disabled)).toBe(disabled);
      expect(createApprovalCoreClient(config, mock, http, disabled)).not.toBe(mock);
    });
  });

  describe('DisabledAlimCoreApprovalClient', () => {
    it('tidak pernah menjawab applied — command berakhir unavailable dan tidak diulang', async () => {
      const client = new DisabledAlimCoreApprovalClient();
      const result = await client.sendApprovalCommand({
        commandId: 'cmd-1',
        requestId: 'req-1',
        decision: 'approved',
        approvedDurationDays: 2,
        actorExternalId: '628123456789',
        actorCorePersonId: null,
        source: 'whatsapp',
        externalMessageId: 'wamid-1',
        messageText: 'SETUJU 2 HARI',
        notes: null,
      });

      expect(result.outcome).toBe('unavailable');
      expect(result.outcome).not.toBe('applied');
      expect(result.code).toBe('core_integration_disabled');
      expect(result.coreStatus).toBeNull();
      // A retry loop would re-log the same refusal for every command and never converge.
      expect(result.retryable).toBe(false);
      // The command id survives, so an operator can still reconcile the row against the reply.
      expect(result.raw).toEqual({ command_id: 'cmd-1', disabled: true });
    });
  });
});
