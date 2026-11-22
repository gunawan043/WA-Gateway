import {
  approvalMetricLines,
  recordApprovalCommand,
  recordApprovalIngestRejection,
  recordApprovalNotification,
  recordApprovalRetryAttempt,
  resetApprovalMetricsForTest,
} from './approval-metrics';

const line = (text: string, needle: string): string => {
  const found = text.split('\n').find(candidate => candidate.startsWith(needle));

  if (found === undefined) throw new Error(`missing series: ${needle}`);

  return found;
};

describe('approval metrics', () => {
  beforeEach(() => resetApprovalMetricsForTest());

  it('emits every known label value at zero before the first event', () => {
    const text = approvalMetricLines().join('\n');

    expect(line(text, 'openwa_approval_command_transitions_total{status="failed"}')).toBe(
      'openwa_approval_command_transitions_total{status="failed"} 0',
    );
    expect(line(text, 'openwa_approval_ingest_rejected_total{reason="credential"}')).toBe(
      'openwa_approval_ingest_rejected_total{reason="credential"} 0',
    );
    expect(line(text, 'openwa_approval_notifications_total{result="failed"}')).toBe(
      'openwa_approval_notifications_total{result="failed"} 0',
    );
    expect(line(text, 'openwa_approval_retry_attempts_total ')).toBe('openwa_approval_retry_attempts_total 0');
  });

  it('counts each command outcome separately', () => {
    recordApprovalCommand('applied');
    recordApprovalCommand('applied');
    recordApprovalCommand('failed');

    const text = approvalMetricLines().join('\n');

    expect(line(text, 'openwa_approval_command_transitions_total{status="applied"}')).toBe(
      'openwa_approval_command_transitions_total{status="applied"} 2',
    );
    expect(line(text, 'openwa_approval_command_transitions_total{status="failed"}')).toBe(
      'openwa_approval_command_transitions_total{status="failed"} 1',
    );
    expect(line(text, 'openwa_approval_command_transitions_total{status="unknown"}')).toBe(
      'openwa_approval_command_transitions_total{status="unknown"} 0',
    );
  });

  it('counts retry attempts, ingest rejections and notification results', () => {
    recordApprovalRetryAttempt();
    recordApprovalRetryAttempt();
    recordApprovalIngestRejection('credential');
    recordApprovalIngestRejection('subject_immutable');
    recordApprovalNotification('sent');
    recordApprovalNotification('failed');

    const text = approvalMetricLines().join('\n');

    expect(line(text, 'openwa_approval_retry_attempts_total ')).toBe('openwa_approval_retry_attempts_total 2');
    expect(line(text, 'openwa_approval_ingest_rejected_total{reason="credential"}')).toBe(
      'openwa_approval_ingest_rejected_total{reason="credential"} 1',
    );
    expect(line(text, 'openwa_approval_ingest_rejected_total{reason="subject_immutable"}')).toBe(
      'openwa_approval_ingest_rejected_total{reason="subject_immutable"} 1',
    );
    expect(line(text, 'openwa_approval_notifications_total{result="sent"}')).toBe(
      'openwa_approval_notifications_total{result="sent"} 1',
    );
    expect(line(text, 'openwa_approval_notifications_total{result="failed"}')).toBe(
      'openwa_approval_notifications_total{result="failed"} 1',
    );
  });

  it('declares every family as a counter with a HELP line', () => {
    const text = approvalMetricLines().join('\n');

    for (const name of [
      'openwa_approval_command_transitions_total',
      'openwa_approval_retry_attempts_total',
      'openwa_approval_ingest_rejected_total',
      'openwa_approval_notifications_total',
    ]) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} counter`);
    }
  });
});
