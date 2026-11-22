import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/** Header yang membawa kredensial layanan Core untuk ingest permohonan. */
export const APPROVAL_INGEST_HEADER = 'x-alim-connect-ingest-key';

/**
 * Autentikasi layanan Core pada `POST /approval/requests`.
 *
 * Sebelum ini, key API `ADMIN` mana pun dapat mengaku sebagai Core: membuat permohonan dengan
 * nama santri dan nomor tujuan yang dikarang, lalu memicu pesan WhatsApp dari gateway. Otorisasi
 * `ADMIN` menjawab "siapa operator Connect", bukan "apakah pemanggil ini Core", jadi keduanya
 * dipisahkan: guard ini menuntut kredensial layanan yang hanya dipegang Core.
 *
 * Gagal tertutup: bila `ALIM_CONNECT_INGEST_KEY` belum disetel, endpoint menjawab 503 dan
 * integrasi tetap tidak aktif — konfigurasi yang belum lengkap tidak boleh berarti "terbuka".
 */
@Injectable()
export class ApprovalIngestGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = (this.config.get<string>('connect.approval.ingestKey') ?? '').trim();

    if (expected === '') {
      throw new ServiceUnavailableException(
        'Ingest permohonan belum dikonfigurasi: ALIM_CONNECT_INGEST_KEY kosong, integrasi Core tidak aktif.',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = headerValue(request);

    if (provided === null || !constantTimeEquals(provided, expected)) {
      throw new UnauthorizedException('Kredensial layanan Core tidak sah.');
    }

    return true;
  }
}

function headerValue(request: Request): string | null {
  const raw = request.headers[APPROVAL_INGEST_HEADER];

  if (typeof raw === 'string') {
    return raw.trim() === '' ? null : raw.trim();
  }

  return null;
}

/** Perbandingan waktu-tetap; panjang berbeda langsung ditolak (panjang bukan rahasia). */
function constantTimeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
}
