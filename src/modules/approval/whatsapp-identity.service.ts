import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsAppIdentity } from './entities/whatsapp-identity.entity';

/**
 * WhatsApp Identity Mapping.
 *
 * Menormalkan nomor/JID dan hanya mengembalikan pemetaan yang sudah
 * diverifikasi. Tidak ada fallback ke teks jabatan atau data lokal lain.
 */
@Injectable()
export class WhatsAppIdentityService {
  private readonly logger = createLogger(WhatsAppIdentityService.name);

  constructor(
    @InjectRepository(WhatsAppIdentity, 'data')
    private readonly identities: Repository<WhatsAppIdentity>,
  ) {}

  /**
   * `0812-3456-7890`, `+62 812 3456 7890`, dan
   * `6281234567890@s.whatsapp.net` → `6281234567890`.
   */
  normalize(value: string | null | undefined): string {
    const raw = (value ?? '').trim().toLowerCase();

    if (raw === '') {
      return '';
    }

    const withoutServer = raw.replace(/@.*$/, '');
    let digits = withoutServer.replace(/[^0-9]/g, '');

    if (digits.startsWith('0')) {
      digits = `62${digits.slice(1)}`;
    }

    return digits;
  }

  /**
   * Bentuk yang boleh disimpan sebagai pemetaan.
   *
   * `normalize` menerima apa saja dan dapat menghasilkan string kosong (mis. `"bukan-nomor"`),
   * sehingga tanpa pemeriksaan ini sebuah baris dengan `externalIdentity: ''` bisa tersimpan —
   * dan baris kosong adalah sasaran empuk untuk pemetaan ulang yang tidak disengaja. Nomor
   * disimpan sebagai digit E.164 tanpa `+`, jadi panjang 8–15 digit adalah batas yang sah.
   */
  private requireNormalized(value: string): string {
    const normalized = this.normalize(value);

    if (!/^[1-9][0-9]{7,14}$/.test(normalized)) {
      throw new BadRequestException('Nomor WhatsApp tidak valid.');
    }

    return normalized;
  }

  async findVerified(value: string): Promise<WhatsAppIdentity | null> {
    const externalIdentity = this.normalize(value);

    if (externalIdentity === '') {
      return null;
    }

    const identity = await this.identities.findOne({
      where: { externalIdentity, isActive: true, isVerified: true },
    });

    if (!identity) {
      return null;
    }

    // Sentuhan terakhir tidak perlu menahan alur; kegagalan di sini tidak
    // boleh menggagalkan keputusan.
    void this.identities
      .update({ id: identity.id }, { lastSeenAt: new Date() })
      .catch((error: unknown) => this.logger.warn(`Gagal memperbarui lastSeenAt: ${String(error)}`));

    return identity;
  }

  /**
   * Menyimpan pemetaan dan melaporkan apa yang berubah, sehingga pemanggil dapat mencatatnya.
   *
   * Aturan yang dijaga:
   *  - `externalIdentity` hanya boleh berpindah orang dengan penanda `reassign` eksplisit;
   *  - pemetaan yang berpindah orang **tidak mewarisi** status terverifikasi — orang baru harus
   *    diverifikasi ulang, karena `isVerified` adalah pernyataan tentang orang, bukan tentang nomor;
   *  - `isVerified` tidak pernah menjadi `true` hanya karena endpoint dipanggil;
   *  - deaktivasi tidak menghapus baris, sehingga riwayat pemetaan tetap ada.
   */
  async upsert(input: {
    externalIdentity: string;
    corePersonId: string;
    displayName?: string | null;
    isVerified?: boolean;
    isActive?: boolean;
    reassign?: boolean;
  }): Promise<WhatsAppIdentityUpsertResult> {
    const externalIdentity = this.requireNormalized(input.externalIdentity);
    const existing = await this.identities.findOne({ where: { externalIdentity } });

    if (existing) {
      return this.applyToExisting(existing, input);
    }

    const isVerified = input.isVerified ?? false;
    const created = await this.identities.save(
      this.identities.create({
        externalIdentity,
        corePersonId: input.corePersonId,
        displayName: input.displayName ?? null,
        isVerified,
        isActive: input.isActive ?? true,
        verifiedAt: isVerified ? new Date() : null,
      }),
    );

    return { identity: created, change: 'create', before: null };
  }

  private async applyToExisting(
    existing: WhatsAppIdentity,
    input: {
      corePersonId: string;
      displayName?: string | null;
      isVerified?: boolean;
      isActive?: boolean;
      reassign?: boolean;
    },
  ): Promise<WhatsAppIdentityUpsertResult> {
    const before = snapshotOf(existing);
    const reassigning = existing.corePersonId !== input.corePersonId;

    if (reassigning && input.reassign !== true) {
      throw new ConflictException({
        code: 'identity_reassign_requires_flag',
        message:
          'Nomor ini sudah dipetakan ke personel Core lain. Kirim `reassign: true` bila perpindahan ini disengaja.',
        currentCorePersonId: existing.corePersonId,
      });
    }

    // Pemetaan yang berpindah orang mulai dari belum terverifikasi, kecuali pemanggil menyatakan
    // verifikasinya pada permintaan yang sama.
    const nextVerified = input.isVerified ?? (reassigning ? false : existing.isVerified);

    existing.corePersonId = input.corePersonId;
    existing.displayName = input.displayName ?? existing.displayName;
    existing.isVerified = nextVerified;
    existing.isActive = input.isActive ?? existing.isActive;
    existing.verifiedAt = nextVerified ? (reassigning ? new Date() : (existing.verifiedAt ?? new Date())) : null;

    const saved = await this.identities.save(existing);

    return { identity: saved, change: changeKind(before, saved), before };
  }
}

/** Jenis tindakan yang dicatat pada audit; satu nilai per perubahan yang mungkin. */
export type WhatsAppIdentityChange = 'create' | 'update' | 'reassign' | 'verify' | 'deactivate';

/** Nilai pemetaan tanpa kolom teknis, dipakai sebagai "sebelum"/"sesudah" pada audit. */
export interface WhatsAppIdentitySnapshot {
  externalIdentity: string;
  corePersonId: string;
  displayName: string | null;
  isVerified: boolean;
  isActive: boolean;
}

export interface WhatsAppIdentityUpsertResult {
  identity: WhatsAppIdentity;
  change: WhatsAppIdentityChange;
  /** `null` untuk pemetaan baru. */
  before: WhatsAppIdentitySnapshot | null;
}

export function snapshotOf(identity: WhatsAppIdentity): WhatsAppIdentitySnapshot {
  return {
    externalIdentity: identity.externalIdentity,
    corePersonId: identity.corePersonId,
    displayName: identity.displayName,
    isVerified: identity.isVerified,
    isActive: identity.isActive,
  };
}

function changeKind(before: WhatsAppIdentitySnapshot, after: WhatsAppIdentity): WhatsAppIdentityChange {
  if (before.corePersonId !== after.corePersonId) {
    return 'reassign';
  }

  if (before.isActive && !after.isActive) {
    return 'deactivate';
  }

  if (!before.isVerified && after.isVerified) {
    return 'verify';
  }

  return 'update';
}
