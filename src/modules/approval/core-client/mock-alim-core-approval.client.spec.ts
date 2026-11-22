import { MockAlimCoreApprovalClient } from './mock-alim-core-approval.client';
import type { CoreApprovalCommand } from './alim-core-approval.client';

/**
 * Mock adalah klien default di luar produksi, dan defaultnya menjawab `applied`. Di produksi
 * jawaban itu akan menjadi konfirmasi persetujuan palsu kepada Kepala Asrama, jadi mock harus
 * menolak sebelum menyentuh skenario apa pun.
 */
describe('MockAlimCoreApprovalClient', () => {
  const command: CoreApprovalCommand = {
    commandId: 'cmd-1',
    requestId: 'req-1',
    decision: 'approved',
    approvedDurationDays: 2,
    actorExternalId: '628111222333',
    actorCorePersonId: 'person-1',
    source: 'whatsapp',
    externalMessageId: 'wamid.1',
    messageText: 'SETUJU 2 HARI',
    notes: null,
  };

  const original = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('menghasilkan keputusan final di luar produksi', async () => {
    process.env.NODE_ENV = 'test';
    const client = new MockAlimCoreApprovalClient();

    const result = await client.sendApprovalCommand(command);

    expect(result.outcome).toBe('applied');
    expect(result.coreStatus).toBe('approved');
  });

  it('menolak mengirim command di produksi, sehingga tidak ada keputusan final', async () => {
    process.env.NODE_ENV = 'production';
    const client = new MockAlimCoreApprovalClient();

    await expect(client.sendApprovalCommand(command)).rejects.toThrow(/tidak boleh dipakai di produksi/);
    expect(client.received).toHaveLength(0);
  });
});
