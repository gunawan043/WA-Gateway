/**
 * Process-local counters for the WhatsApp approval workflow.
 *
 * Kept in-process (no prom-client), like the webhook and ingress counters: a `COUNT(*)` over
 * `approval_commands` would be non-monotonic because rows change status, and Prometheus `counter`
 * semantics forbid that (a status change would look like a reset). These counters only reset on
 * restart, which `rate()`/`increase()` already tolerate.
 *
 * The series exist so an operator can answer three questions without a database session: is the
 * retry worker making progress, are commands piling up as FAILED, and is Core rejecting us.
 */

/** Terminal or intermediate state a command reaches, one increment per transition. */
export type ApprovalCommandOutcome = 'applied' | 'duplicate' | 'rejected' | 'unknown' | 'failed';

/** Why an ingest call was refused; `credential`/`not_configured` come from the guard. */
export type ApprovalIngestRejection = 'credential' | 'not_configured' | 'subject_immutable' | 'invalid';

/** Outcome of one notification attempt; `skipped` means the permit had no session or target yet. */
export type ApprovalNotificationResult = 'sent' | 'skipped' | 'failed';

const COMMAND_OUTCOMES: readonly ApprovalCommandOutcome[] = ['applied', 'duplicate', 'rejected', 'unknown', 'failed'];
const INGEST_REJECTIONS: readonly ApprovalIngestRejection[] = [
  'credential',
  'not_configured',
  'subject_immutable',
  'invalid',
];
const NOTIFICATION_RESULTS: readonly ApprovalNotificationResult[] = ['sent', 'skipped', 'failed'];

const commandTotals = new Map<ApprovalCommandOutcome, number>();
const ingestRejectionTotals = new Map<ApprovalIngestRejection, number>();
const notificationTotals = new Map<ApprovalNotificationResult, number>();
let retryAttemptTotal = 0;

function bump<K>(totals: Map<K, number>, key: K): void {
  totals.set(key, (totals.get(key) ?? 0) + 1);
}

/** Record the state a command moved to. */
export function recordApprovalCommand(outcome: ApprovalCommandOutcome): void {
  bump(commandTotals, outcome);
}

/** Record one retry send attempt (a claimed row actually handed to the processor). */
export function recordApprovalRetryAttempt(): void {
  retryAttemptTotal += 1;
}

/** Record an ingest call refused before it could change anything. */
export function recordApprovalIngestRejection(reason: ApprovalIngestRejection): void {
  bump(ingestRejectionTotals, reason);
}

/** Record one notification attempt. */
export function recordApprovalNotification(result: ApprovalNotificationResult): void {
  bump(notificationTotals, result);
}

/** Prometheus exposition lines; every known label value is emitted so an alert can match before the first event. */
export function approvalMetricLines(): string[] {
  const lines: string[] = [];

  lines.push(
    '# HELP openwa_approval_command_transitions_total Approval command state transitions since process start. A command retried as UNKNOWN counts once per transition; a terminal state counts once.',
  );
  lines.push('# TYPE openwa_approval_command_transitions_total counter');

  for (const outcome of COMMAND_OUTCOMES) {
    lines.push(`openwa_approval_command_transitions_total{status="${outcome}"} ${commandTotals.get(outcome) ?? 0}`);
  }

  lines.push(
    '# HELP openwa_approval_retry_attempts_total Approval command retries claimed by the worker for sending since process start.',
  );
  lines.push('# TYPE openwa_approval_retry_attempts_total counter');
  lines.push(`openwa_approval_retry_attempts_total ${retryAttemptTotal}`);

  lines.push(
    '# HELP openwa_approval_ingest_rejected_total Permit ingest calls refused, by reason, since process start.',
  );
  lines.push('# TYPE openwa_approval_ingest_rejected_total counter');

  for (const reason of INGEST_REJECTIONS) {
    lines.push(`openwa_approval_ingest_rejected_total{reason="${reason}"} ${ingestRejectionTotals.get(reason) ?? 0}`);
  }

  lines.push('# HELP openwa_approval_notifications_total Approval notifications by result since process start.');
  lines.push('# TYPE openwa_approval_notifications_total counter');

  for (const result of NOTIFICATION_RESULTS) {
    lines.push(`openwa_approval_notifications_total{result="${result}"} ${notificationTotals.get(result) ?? 0}`);
  }

  return lines;
}

/** Test helper: drop every counter back to zero. */
export function resetApprovalMetricsForTest(): void {
  commandTotals.clear();
  ingestRejectionTotals.clear();
  notificationTotals.clear();
  retryAttemptTotal = 0;
}
