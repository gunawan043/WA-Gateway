import { ApprovalConfirmationService } from './approval-confirmation.service';
import type { ApprovalNotificationService } from './approval-notification.service';
import type { ApprovalRequest } from './entities/approval-request.entity';

/**
 * Isi pesan konfirmasi dan perilaku pengirimannya.
 *
 * Dua hal yang dijaga di sini: pesan tidak pernah menyatakan hasil yang belum diketahui Core,
 * dan kegagalan mengirim konfirmasi tidak boleh melempar error ke pemanggil (status keputusan
 * sudah tersimpan dan tidak boleh ikut gagal).
 */
describe('ApprovalConfirmationService', () => {
  let sent: Array<{ sessionId: string; chatId: string; text: string }>;
  let failSend: boolean;
  let service: ApprovalConfirmationService;

  const request = {
    reference: 'IZN-2026-00125',
    status: 'APPROVED',
    coreStatus: 'approved',
    sessionId: 'sess-approval',
    targetIdentity: '628111222333@s.whatsapp.net',
    expectedReturnAt: new Date('2026-11-25T08:00:00.000Z'),
  } as ApprovalRequest;

  beforeEach(() => {
    sent = [];
    failSend = false;
    service = new ApprovalConfirmationService(
      {
        // eslint-disable-next-line @typescript-eslint/require-await -- tiruan MessageService.sendText yang async
        sendText: jest.fn(async (sessionId: string, dto: { chatId: string; text: string }) => {
          if (failSend) throw new Error('socket closed');
          sent.push({ sessionId, chatId: dto.chatId, text: dto.text });

          return { messageId: 'wamid.out.1', timestamp: 1 };
        }),
      } as never,
      { toChatId: (identity: string) => identity.replace('@s.whatsapp.net', '@c.us') } as ApprovalNotificationService,
    );
  });

  it('menyebut durasi dan perkiraan kembali saat disetujui', async () => {
    await service.approved(request, 2, '2026-11-25T08:00:00.000Z');

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe('628111222333@c.us');
    expect(sent[0].text).toContain('*DISETUJUI*');
    expect(sent[0].text).toContain('Durasi: 2 hari');
    expect(sent[0].text).toContain('2026-11-25 08:00');
  });

  it('memakai durasi permohonan bila Core tidak menyebut jumlah hari', async () => {
    await service.approved(request, null, null);

    expect(sent[0].text).toContain('Durasi: sesuai permohonan');
    expect(sent[0].text).toContain('2026-11-25 08:00');
  });

  it('menyebut status Core saat izin sudah diputuskan', async () => {
    await service.alreadyDecided({ ...request, status: 'PENDING_APPROVAL' });

    expect(sent[0].text).toContain('sudah diputuskan (status: approved)');
  });

  it('menampilkan durasi yang tidak dikenali tanpa mengarang angka', async () => {
    await service.invalidDuration(request, null);
    await service.invalidDuration(request, 400);

    expect(sent[0].text).toContain('"tidak dikenali"');
    expect(sent[1].text).toContain('"400"');
    expect(sent[1].text).toContain('antara 1 dan 365');
  });

  it('tidak membocorkan referensi izin ke nomor tak dikenal', async () => {
    await service.unknownSender('sess-approval', '628999000111@c.us');

    expect(sent[0].text).not.toContain(request.reference);
    expect(sent[0].text).toContain('belum terdaftar');
  });

  it('melewati pengiriman bila sesi atau tujuan tidak tersedia', async () => {
    await service.notFound(null, '628111222333@c.us', request.reference);
    await service.notFound('sess-approval', null, request.reference);

    expect(sent).toHaveLength(0);
  });

  it('tidak melempar error ketika pengiriman konfirmasi gagal', async () => {
    failSend = true;

    await expect(service.rejected(request)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
