import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * First-response report over a date range.
 *
 * "Eligible" means the conversation was measured against a division target (`slaMinutes` was set
 * when its window opened). Compliance is `(eligible - breached) / eligible`; a conversation that was
 * never eligible is not counted as a success, and a range with no eligible conversation reports
 * `null` rather than a misleading 100%.
 *
 * `slaBreached` counts the CURRENT window of each conversation: a new customer message restarts the
 * window and clears the flag, so the number answers "how many are overdue now", not "how many were
 * ever overdue". The audit log keeps every individual breach.
 */
export class InboxReportTotalsDto {
  @ApiProperty({ description: 'Conversations whose first inbound message falls in the range.' })
  conversations!: number;

  @ApiProperty()
  open!: number;

  @ApiProperty()
  resolved!: number;

  @ApiProperty({ description: 'Conversations with no assignee.' })
  unassigned!: number;

  @ApiProperty({ description: 'Conversations that have never received a human reply.' })
  awaitingFirstResponse!: number;

  @ApiPropertyOptional({
    type: 'number',
    nullable: true,
    description: 'Mean minutes between the first customer message and the first human reply. Null with no sample.',
  })
  avgFirstResponseMinutes!: number | null;

  @ApiProperty({ description: 'Conversations measured against a division target.' })
  slaEligible!: number;

  @ApiProperty({ description: 'Eligible conversations whose current window is overdue.' })
  slaBreached!: number;

  @ApiPropertyOptional({
    type: 'number',
    nullable: true,
    description: 'Fraction 0–1 of eligible conversations that met the target. Null when nothing was eligible.',
  })
  slaComplianceRate!: number | null;
}

export class InboxReportDivisionDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Null for conversations with no division tag.' })
  divisionId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  divisionName!: string | null;

  @ApiProperty()
  conversations!: number;

  @ApiProperty()
  slaEligible!: number;

  @ApiProperty()
  slaBreached!: number;

  @ApiPropertyOptional({ type: 'number', nullable: true })
  avgFirstResponseMinutes!: number | null;

  @ApiPropertyOptional({ type: 'number', nullable: true })
  slaComplianceRate!: number | null;
}

export class InboxReportAgentDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Null for unassigned conversations.' })
  assigneeKeyId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  assigneeName!: string | null;

  @ApiProperty()
  conversations!: number;

  @ApiProperty()
  resolved!: number;

  @ApiProperty()
  slaEligible!: number;

  @ApiProperty()
  slaBreached!: number;

  @ApiPropertyOptional({ type: 'number', nullable: true })
  avgFirstResponseMinutes!: number | null;
}

export class InboxReportDailyDto {
  @ApiProperty({ example: '2026-11-20', description: 'UTC day.' })
  date!: string;

  @ApiProperty()
  conversations!: number;

  @ApiProperty()
  slaBreached!: number;

  @ApiPropertyOptional({ type: 'number', nullable: true })
  avgFirstResponseMinutes!: number | null;
}

export class InboxReportDto {
  @ApiProperty({ description: 'ISO instant the range starts (inclusive).' })
  from!: string;

  @ApiProperty({ description: 'ISO instant the range ends (inclusive).' })
  to!: string;

  @ApiProperty({ type: InboxReportTotalsDto })
  totals!: InboxReportTotalsDto;

  @ApiProperty({ type: [InboxReportDivisionDto] })
  byDivision!: InboxReportDivisionDto[];

  @ApiProperty({ type: [InboxReportAgentDto] })
  byAgent!: InboxReportAgentDto[];

  @ApiProperty({ type: [InboxReportDailyDto] })
  daily!: InboxReportDailyDto[];
}
