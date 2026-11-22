import { randomUUID } from 'crypto';
import type { ApprovalCommand } from './entities/approval-command.entity';
import {
  sanitizeCommandCode,
  sanitizeCommandMessage,
  toApprovalCommandView,
} from './dto/approval-command-response.dto';

const command = (overrides: Partial<ApprovalCommand> = {}): ApprovalCommand => ({
  id: randomUUID(),
  commandId: randomUUID(),
  approvalRequestId: randomUUID(),
  externalMessageId: 'wamid.inbound-secret',
  decision: 'approved',
  durationDays: 2,
  status: 'FAILED',
  attempts: 5,
  coreResponseCode: 503,
  coreResponseBody: { internal: 'raw Core body' },
  errorCode: 'core_unreachable',
  lastError: 'Core tidak dapat dihubungi.',
  lastAttemptAt: null,
  nextAttemptAt: null,
  sentAt: null,
  resolvedAt: null,
  createdAt: new Date('2026-11-22T02:00:00.000Z'),
  updatedAt: new Date('2026-11-22T02:00:00.000Z'),
  ...overrides,
});

describe('ApprovalCommandView', () => {
  it('exposes exactly the fields an operator needs', () => {
    const view = toApprovalCommandView(command());

    expect(Object.keys(view).sort()).toEqual(
      [
        'approvalRequestId',
        'attempts',
        'commandId',
        'coreResponseCode',
        'createdAt',
        'decision',
        'durationDays',
        'errorCode',
        'id',
        'lastAttemptAt',
        'lastError',
        'nextAttemptAt',
        'resolvedAt',
        'sentAt',
        'status',
        'updatedAt',
      ].sort(),
    );
  });

  it('never returns the raw Core body or the WhatsApp message id', () => {
    const view = toApprovalCommandView(command());

    expect(view).not.toHaveProperty('coreResponseBody');
    expect(view).not.toHaveProperty('externalMessageId');
    expect(JSON.stringify(view)).not.toContain('raw Core body');
    expect(JSON.stringify(view)).not.toContain('wamid.inbound-secret');
  });
});

describe('sanitizeCommandMessage', () => {
  it('keeps the fixed Connect messages unchanged', () => {
    expect(sanitizeCommandMessage('Core tidak merespons tepat waktu.')).toBe('Core tidak merespons tepat waktu.');
  });

  it('redacts URLs, emails, long digit runs and credential pairs', () => {
    const message =
      'POST https://core.internal/api/approval gagal untuk 6281234567890, admin@alim.sch.id, Authorization: Bearer abc123';

    const sanitized = sanitizeCommandMessage(message) ?? '';

    expect(sanitized).not.toContain('https://core.internal');
    expect(sanitized).not.toContain('6281234567890');
    expect(sanitized).not.toContain('admin@alim.sch.id');
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).toContain('[url]');
    expect(sanitized).toContain('[number]');
    expect(sanitized).toContain('[email]');
  });

  it('redacts a bare bearer token without a header name', () => {
    expect(sanitizeCommandMessage('ditolak: Bearer s3cr3t-value')).toBe('ditolak: [redacted]');
  });

  it('does not mangle prose that merely mentions a credential word', () => {
    // Tanpa pemisah `:` atau `=`, kata seperti "token" adalah bagian kalimat biasa.
    expect(sanitizeCommandMessage('Token verifikasi tidak cocok.')).toBe('Token verifikasi tidak cocok.');
  });

  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeCommandMessage('baris satu\n\n\tbaris\u0000dua')).toBe('baris satu baris dua');
  });

  it('truncates a long message instead of returning it whole', () => {
    const sanitized = sanitizeCommandMessage('a'.repeat(500)) ?? '';

    expect(sanitized).toHaveLength(200);
    expect(sanitized.endsWith('...')).toBe(true);
  });

  it('returns null for empty input', () => {
    expect(sanitizeCommandMessage('')).toBeNull();
    expect(sanitizeCommandMessage('   ')).toBeNull();
    expect(sanitizeCommandMessage(null)).toBeNull();
  });
});

describe('sanitizeCommandCode', () => {
  it('keeps a normal error code', () => {
    expect(sanitizeCommandCode('core_unreachable')).toBe('core_unreachable');
    expect(sanitizeCommandCode('approval.subject:invalid')).toBe('approval.subject:invalid');
  });

  it('drops a value that is not shaped like a code', () => {
    expect(sanitizeCommandCode('Nama santri Ahmad, nomor 6281234567890')).toBeNull();
    expect(sanitizeCommandCode('kode dengan spasi')).toBeNull();
    expect(sanitizeCommandCode('')).toBeNull();
  });
});
