import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { WhatsAppIdentity } from './entities/whatsapp-identity.entity';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

/**
 * Batas keamanan pemetaan identitas WhatsApp.
 *
 * Pemetaan ini adalah satu-satunya alasan Connect menganggap sebuah nomor berwenang menjawab
 * permohonan, jadi tiga sifatnya harus dijaga dan diuji terhadap database sungguhan (bukan
 * repository tiruan — `where` yang salah hanya terlihat saat dijalankan):
 *
 *  - hanya baris `isVerified` **dan** `isActive` yang dipakai;
 *  - penulisan format nomor tidak bisa dipakai untuk menghindari pemetaan yang sudah ada;
 *  - `verifiedAt` mengikuti `isVerified`, sehingga jejak verifikasi tidak berbohong.
 *
 * Perbaikan/pengetatan endpoint tulisnya (aktor, penolakan pengalihan diam-diam, pencabutan)
 * sengaja belum diterapkan; lihat laporan review §1 untuk temuan dan rekomendasinya.
 */
describe('WhatsAppIdentityService (batas keamanan)', () => {
  const NUMBER = '628111222333';
  const PERSON = '9d1c5f2e-1f5a-4c39-9b1a-0b2c3d4e5f60';
  const OTHER = '3f7b2a10-6c48-4d0e-8a51-2b9c7d6e4f01';

  let ds: DataSource;
  let repo: Repository<WhatsAppIdentity>;
  let service: WhatsAppIdentityService;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [WhatsAppIdentity],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(WhatsAppIdentity);
    service = new WhatsAppIdentityService(repo);
  });

  afterAll(async () => {
    // `findVerified` memperbarui `lastSeenAt` tanpa di-await; beri kesempatan selesai sebelum
    // koneksi ditutup supaya tidak muncul penolakan yang tidak tertangani.
    await new Promise(resolve => setImmediate(resolve));
    await ds.destroy();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  async function seed(overrides: Partial<WhatsAppIdentity> = {}): Promise<WhatsAppIdentity> {
    return repo.save(
      repo.create({
        externalIdentity: NUMBER,
        corePersonId: PERSON,
        displayName: 'Kepala Asrama',
        isVerified: true,
        isActive: true,
        verifiedAt: new Date(),
        ...overrides,
      }),
    );
  }

  it('mengembalikan pemetaan yang terverifikasi dan aktif', async () => {
    await seed();

    expect(await service.findVerified(NUMBER)).toMatchObject({ corePersonId: PERSON });
  });

  it('menolak nomor yang belum diverifikasi', async () => {
    await seed({ isVerified: false });

    expect(await service.findVerified(NUMBER)).toBeNull();
  });

  it('menolak nomor yang sudah dinonaktifkan', async () => {
    await seed({ isActive: false });

    expect(await service.findVerified(NUMBER)).toBeNull();
  });

  it('menolak nomor yang tidak terpetakan', async () => {
    await seed();

    expect(await service.findVerified('628999000111')).toBeNull();
  });

  it('menolak masukan kosong atau tanpa digit tanpa menyentuh tabel', async () => {
    await seed({ externalIdentity: '' });

    expect(await service.findVerified('')).toBeNull();
    expect(await service.findVerified('   ')).toBeNull();
    expect(await service.findVerified('bukan-nomor')).toBeNull();
  });

  it('menormalkan semua penulisan nomor ke baris yang sama', async () => {
    await seed();

    for (const written of ['0811-1222-333', '+62 811 1222 333', `${NUMBER}@s.whatsapp.net`, ' 628111222333 ']) {
      expect(await service.findVerified(written)).toMatchObject({ corePersonId: PERSON });
    }
  });

  it('memperbarui baris yang sama saat nomor dikirim dalam format berbeda', async () => {
    const first = await service.upsert({ externalIdentity: '0811-1222-333', corePersonId: PERSON, isVerified: true });
    const second = await service.upsert({
      externalIdentity: `+62 811 1222 333@s.whatsapp.net`,
      corePersonId: PERSON,
      displayName: 'Kepala Asrama Putra 1',
      isVerified: true,
    });

    expect(second.identity.id).toBe(first.identity.id);
    expect(second.change).toBe('update');
    expect(await repo.count()).toBe(1);
    expect(second.identity.displayName).toBe('Kepala Asrama Putra 1');
  });

  it('tidak menandai terverifikasi hanya karena endpoint dipanggil', async () => {
    const created = await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON });

    expect(created.change).toBe('create');
    expect(created.before).toBeNull();
    expect(created.identity.isVerified).toBe(false);
    expect(created.identity.verifiedAt).toBeNull();
    expect(await service.findVerified(NUMBER)).toBeNull();
  });

  it('melaporkan jenis perubahan verify dan deactivate beserta nilai sebelumnya', async () => {
    await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON });

    const verified = await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON, isVerified: true });
    expect(verified.change).toBe('verify');
    expect(verified.before).toMatchObject({ isVerified: false, isActive: true });

    const deactivated = await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON, isActive: false });
    expect(deactivated.change).toBe('deactivate');
    expect(deactivated.before).toMatchObject({ isActive: true, isVerified: true });
    expect(deactivated.identity.isActive).toBe(false);
  });

  it('menolak pemindahan ke personel Core lain tanpa penanda reassign', async () => {
    await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON, isVerified: true });

    await expect(service.upsert({ externalIdentity: NUMBER, corePersonId: OTHER })).rejects.toBeInstanceOf(
      ConflictException,
    );

    const row = await repo.findOneByOrFail({ externalIdentity: NUMBER });
    expect(row.corePersonId).toBe(PERSON);
    expect(row.isVerified).toBe(true);
  });

  it('memindahkan pemetaan dengan penanda reassign dan mencabut verifikasi lama', async () => {
    await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON, isVerified: true });

    const moved = await service.upsert({ externalIdentity: NUMBER, corePersonId: OTHER, reassign: true });

    expect(moved.change).toBe('reassign');
    expect(moved.before).toMatchObject({ corePersonId: PERSON, isVerified: true });
    expect(moved.identity.corePersonId).toBe(OTHER);
    expect(moved.identity.isVerified).toBe(false);
    expect(moved.identity.verifiedAt).toBeNull();
    expect(await service.findVerified(NUMBER)).toBeNull();
  });

  it('mengizinkan verifikasi eksplisit pada pemindahan yang disengaja', async () => {
    await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON, isVerified: true });

    const moved = await service.upsert({
      externalIdentity: NUMBER,
      corePersonId: OTHER,
      reassign: true,
      isVerified: true,
    });

    expect(moved.identity.isVerified).toBe(true);
    expect(moved.identity.verifiedAt).not.toBeNull();
    expect(await service.findVerified(NUMBER)).toMatchObject({ corePersonId: OTHER });
  });

  it('mengosongkan verifiedAt ketika verifikasi dicabut', async () => {
    const created = await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON, isVerified: true });
    expect(created.identity.verifiedAt).not.toBeNull();

    const revoked = await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON, isVerified: false });

    expect(revoked.identity.isVerified).toBe(false);
    expect(revoked.identity.verifiedAt).toBeNull();
    expect(await service.findVerified(NUMBER)).toBeNull();
  });

  it('mencabut akses lewat isActive tanpa menghapus pemetaan', async () => {
    await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON, isVerified: true });
    expect(await service.findVerified(NUMBER)).not.toBeNull();

    const revoked = await service.upsert({ externalIdentity: NUMBER, corePersonId: PERSON, isActive: false });

    expect(revoked.identity.isActive).toBe(false);
    expect(revoked.identity.isVerified).toBe(true);
    expect(await service.findVerified(NUMBER)).toBeNull();
    expect(await repo.count()).toBe(1);
  });

  it('menolak nomor yang tidak dapat dinormalkan menjadi digit', async () => {
    for (const written of ['', '   ', 'bukan-nomor', 'abc123']) {
      await expect(service.upsert({ externalIdentity: written, corePersonId: PERSON })).rejects.toThrow(
        'Nomor WhatsApp tidak valid.',
      );
    }

    expect(await repo.count()).toBe(0);
  });

  it('menolak nomor yang terlalu pendek untuk menjadi nomor E.164', async () => {
    await expect(service.upsert({ externalIdentity: '0812', corePersonId: PERSON })).rejects.toThrow(
      'Nomor WhatsApp tidak valid.',
    );
  });
});
