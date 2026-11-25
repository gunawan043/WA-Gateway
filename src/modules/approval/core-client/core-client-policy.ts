/**
 * Kebijakan pemilihan klien ALIM Core.
 *
 * Tiga mode, dan perbedaannya adalah inti dari kebijakan ini:
 *
 *  - `http`     memakai Core nyata. Satu-satunya mode yang boleh mengirim keputusan.
 *  - `disabled` integrasi approval dimatikan. Tidak ada keputusan yang pernah dikirim, dan rute
 *               ingest menjawab 503. Ini mode yang benar ketika ALIM Connect harus berjalan
 *               (dashboard, sesi WhatsApp, inbox, API key) sementara integrasi Core belum disepakati.
 *  - `mock`     klien uji yang menjawab `applied` secara default. Di produksi itu berarti Connect
 *               dapat menandai permohonan `APPROVED` dan mengirim konfirmasi "disetujui" kepada Kepala
 *               Asrama tanpa Core pernah menyetujui apa pun — keputusan palsu yang dikonfirmasi ke
 *               pengguna, bukan sekadar data uji. Karena itu `mock` DITOLAK di produksi.
 *
 * Mengapa `disabled` bukan sekadar "mock": keduanya sama-sama tidak menghubungi Core, tetapi `mock`
 * mengarang persetujuan sedangkan `disabled` menolak memproses apa pun. Menyamakan keduanya adalah
 * cara sebuah integrasi yang belum siap menjadi integrasi yang berpura-pura siap.
 *
 * Pemilihan divalidasi pada jalur startup (factory provider), bukan hanya didokumentasikan:
 * konfigurasi yang tidak aman harus menggagalkan boot, bukan berjalan diam-diam.
 */
export interface ApprovalCoreClientSelection {
  /** `http` memakai Core nyata, `disabled` mematikan integrasi; `mock` hanya untuk non-produksi. */
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

/** True only for the explicit opt-out, so a typo in the value can never be read as "disabled". */
export function isApprovalIntegrationDisabled(selection: ApprovalCoreClientSelection): boolean {
  return selection.coreClient.trim().toLowerCase() === 'disabled';
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

  // `disabled` is a deliberate, safe posture: nothing is ever decided. It must pass here, otherwise
  // ALIM Connect could not start at all until ALIM Core integration is agreed — and the deployment
  // requirement is that Connect runs on its own.
  if (isApprovalIntegrationDisabled(selection)) {
    return;
  }

  if (selection.coreClient !== 'http') {
    throw new ApprovalCoreClientConfigError(
      'ALIM_CONNECT_CORE_CLIENT harus "http" atau "disabled" di produksi: mock Core dapat menandai ' +
        'permohonan APPROVED tanpa persetujuan ALIM Core, sementara "disabled" tidak pernah ' +
        'memutuskan apa pun. Setel ALIM_CONNECT_CORE_CLIENT=http atau =disabled.',
    );
  }

  const missing = [
    selection.coreBaseUrl.trim() === '' ? 'ALIM_CORE_BASE_URL' : null,
    selection.coreApiKey.trim() === '' ? 'ALIM_CORE_APPROVAL_API_KEY' : null,
  ].filter((key): key is string => key !== null);

  if (missing.length > 0) {
    throw new ApprovalCoreClientConfigError(
      `ALIM_CONNECT_CORE_CLIENT=http di produksi membutuhkan ${missing.join(' dan ')}. ` +
        'Bila integrasi Core belum diaktifkan, setel ALIM_CONNECT_CORE_CLIENT=disabled.',
    );
  }
}
