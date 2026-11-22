import { ExecutionContext, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApprovalController } from './approval.controller';
import { APPROVAL_INGEST_HEADER, ApprovalIngestGuard } from './approval-ingest.guard';

/**
 * `POST /approval/requests` menerima data yang memicu pesan WhatsApp, jadi pemanggilnya harus
 * Core — bukan sekadar operator Connect dengan key ADMIN. Guard ini adalah pembeda itu, dan ia
 * gagal tertutup: tanpa kunci layanan yang dikonfigurasi, endpoint tidak aktif.
 */
describe('ApprovalIngestGuard', () => {
  const guardFor = (key: string | undefined): ApprovalIngestGuard =>
    new ApprovalIngestGuard({ get: () => key } as unknown as ConfigService);

  const contextFor = (headers: Record<string, string>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    }) as unknown as ExecutionContext;

  it('menolak dengan 503 ketika kunci ingest belum dikonfigurasi', () => {
    expect(() => guardFor('').canActivate(contextFor({}))).toThrow(ServiceUnavailableException);
    expect(() => guardFor('   ').canActivate(contextFor({}))).toThrow(ServiceUnavailableException);
    expect(() => guardFor(undefined).canActivate(contextFor({}))).toThrow(ServiceUnavailableException);
  });

  it('menolak permintaan tanpa header kredensial', () => {
    expect(() => guardFor('rahasia-core').canActivate(contextFor({}))).toThrow(UnauthorizedException);
  });

  it('menolak header kosong dan header yang salah', () => {
    const guard = guardFor('rahasia-core');

    expect(() => guard.canActivate(contextFor({ [APPROVAL_INGEST_HEADER]: '' }))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextFor({ [APPROVAL_INGEST_HEADER]: '   ' }))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextFor({ [APPROVAL_INGEST_HEADER]: 'rahasia-lain' }))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(contextFor({ [APPROVAL_INGEST_HEADER]: 'rahasia-core-lebih-panjang' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('menerima kredensial yang cocok, termasuk spasi di tepi', () => {
    const guard = guardFor('rahasia-core');

    expect(guard.canActivate(contextFor({ [APPROVAL_INGEST_HEADER]: 'rahasia-core' }))).toBe(true);
    expect(guard.canActivate(contextFor({ [APPROVAL_INGEST_HEADER]: '  rahasia-core  ' }))).toBe(true);
  });

  it('terpasang pada route ingest, bukan hanya tersedia sebagai kelas', () => {
    const handler = Object.getOwnPropertyDescriptor(ApprovalController.prototype, 'ingest')?.value as
      object | undefined;
    const guards =
      handler === undefined ? undefined : (Reflect.getMetadata('__guards__', handler) as unknown[] | undefined);

    expect(guards).toBeDefined();
    expect(guards?.some(guard => guard === ApprovalIngestGuard)).toBe(true);
  });
});
