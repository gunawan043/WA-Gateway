/**
 * Bounds what is persisted from ALIM Core's reply.
 *
 * The body is kept for one purpose: a person deciding whether a command must be sent again. It is
 * never returned by the API — `ApprovalCommandView` deliberately omits it — and it is never logged.
 * What it is not allowed to do is grow without a ceiling: `response.json()` accepts whatever Core
 * sends, and a Core-side regression that answers with a large payload (or an HTML error page
 * wrapped in JSON) would otherwise be copied into every row of `approval_commands`, into every
 * backup, and into every restore.
 *
 * A body that fits is stored exactly as received, so nothing about the normal case changes. A body
 * that does not fit keeps its size and a readable prefix — enough to recognise the failure, bounded
 * enough that one command cannot dominate the table.
 */
export const MAX_STORED_CORE_BODY_BYTES = 16 * 1024;

/** How much of an oversized body survives, as text, for diagnosis. */
export const CORE_BODY_PREVIEW_BYTES = 4096;

export function boundCoreBody(raw: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    // A value JSON cannot represent is not worth failing the decision over; record that it existed.
    return { unserializable: true };
  }

  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_STORED_CORE_BODY_BYTES) {
    return raw;
  }

  return {
    truncated: true,
    originalBytes: bytes,
    preview: serialized.slice(0, CORE_BODY_PREVIEW_BYTES),
  };
}
