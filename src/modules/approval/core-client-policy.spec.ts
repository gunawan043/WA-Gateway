import { ConfigService } from '@nestjs/config';
import { ApprovalCoreClientConfigError, assertApprovalCoreClientAllowed } from './core-client/core-client-policy';
import { createApprovalCoreClient } from './approval.module';
import { MockAlimCoreApprovalClient } from './core-client/mock-alim-core-approval.client';
import { HttpAlimCoreApprovalClient } from './core-client/http-alim-core-approval.client';

/**
 * Pemilihan klien Core berjalan pada jalur startup (`useFactory`), jadi yang diuji di sini adalah
 * fungsi yang benar-benar dipanggil Nest saat boot — bukan salinan logikanya.
 */
describe('Kebijakan klien ALIM Core', () => {
  const http = { name: 'http' } as unknown as HttpAlimCoreApprovalClient;
  const mock = { name: 'mock' } as unknown as MockAlimCoreApprovalClient;

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
      ).toThrow(/ALIM_CONNECT_CORE_CLIENT harus "http" di produksi/);
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
      expect(createApprovalCoreClient(configFor({}), mock, http)).toBe(mock);
    });

    it('mengembalikan klien HTTP saat dikonfigurasi', () => {
      const config = configFor({
        'connect.approval.coreClient': 'http',
        'connect.approval.coreBaseUrl': 'https://core.example',
        'connect.approval.coreApiKey': 'k',
      });

      expect(createApprovalCoreClient(config, mock, http)).toBe(http);
    });
  });
});
