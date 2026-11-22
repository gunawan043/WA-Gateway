/**
 * Kebijakan pemilihan klien ALIM Core.
 *
 * `mock` ada untuk pengembangan dan pengujian, dan mock menjawab `applied` secara default. Di
 * produksi itu berarti Connect dapat menandai permohonan `APPROVED` dan mengirim konfirmasi
 * "disetujui" kepada Kepala Asrama tanpa Core pernah menyetujui apa pun — keputusan palsu yang
 * dikonfirmasi ke pengguna, bukan sekadar data uji. Karena itu pemilihan klien divalidasi pada
 * jalur startup (factory provider), bukan hanya didokumentasikan: konfigurasi yang tidak aman
 * harus menggagalkan boot, bukan berjalan diam-diam.
 */
export interface ApprovalCoreClientSelection {
  /** `http` memakai Core nyata; nilai lain diperlakukan sebagai mock. */
  coreClient: string;
  coreBaseUrl: string;
  coreApiKey: string;
}

/** Nama variabel yang harus diperbaiki operator, tanpa pernah memuat nilainya. */
export class ApprovalCoreClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalCoreClientConfigError';
  }
}

/**
 * Melempar bila konfigurasi produksi akan memakai mock, atau akan memakai klien HTTP tanpa
 * alamat/kunci. Lingkungan non-produksi tetap bebas memakai mock.
 */
export function assertApprovalCoreClientAllowed(
  selection: ApprovalCoreClientSelection,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  if (nodeEnv !== 'production') {
    return;
  }

  if (selection.coreClient !== 'http') {
    throw new ApprovalCoreClientConfigError(
      'ALIM_CONNECT_CORE_CLIENT harus "http" di produksi: mock Core dapat menandai permohonan ' +
        'APPROVED tanpa persetujuan ALIM Core. Setel ALIM_CONNECT_CORE_CLIENT=http.',
    );
  }

  const missing = [
    selection.coreBaseUrl.trim() === '' ? 'ALIM_CORE_BASE_URL' : null,
    selection.coreApiKey.trim() === '' ? 'ALIM_CORE_APPROVAL_API_KEY' : null,
  ].filter((key): key is string => key !== null);

  if (missing.length > 0) {
    throw new ApprovalCoreClientConfigError(
      `ALIM_CONNECT_CORE_CLIENT=http di produksi membutuhkan ${missing.join(' dan ')}.`,
    );
  }
}
