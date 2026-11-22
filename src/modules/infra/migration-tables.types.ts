// Database migration types for export/import
export interface SessionRow {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  pushName: string | null;
  config: string | Record<string, unknown>;
  proxyUrl: string | null;
  proxyType: string | null;
  connectedAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Absent from backups written before the column existed.
  desiredState?: string | null;
}

export interface WebhookRow {
  id: string;
  sessionId: string;
  url: string;
  events: string | string[];
  // Credentials. export-data omits both (see exportData), so an exported row may not carry them;
  // the importer restores them as null/{} in that case.
  secret?: string | null;
  headers?: string | Record<string, string>;
  filters: string | Record<string, unknown> | null;
  active: boolean | number;
  retryCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Shapes mirror the REAL table columns as returned by `SELECT *` (export-data), not the
// camelCase TypeORM entity properties. `messages` columns are the property names; `message_batches`
// columns are snake_case (the entity maps them via `name:`). Keeping these accurate is what keeps
// the import column lists below from drifting back into "no such column" failures.
export interface MessageRow {
  id: string;
  sessionId: string;
  waMessageId: string | null;
  chatId: string;
  chatName: string | null;
  /** Group participant JID (nullable; added to messages after chatName — keep the import list in sync). */
  author: string | null;
  from: string;
  to: string;
  body: string | null;
  type: string;
  direction: string;
  timestamp: number | string | null;
  metadata: string | Record<string, unknown> | null;
  status: string;
  createdAt: string;
  /**
   * Chat-media archive pointers (nullable; added after author — keep the import list in sync).
   * Dropping these on import would leave the archived FILES restored but unreferenced, and the
   * orphan sweep would then delete them after its grace window.
   */
  mediaPath: string | null;
  mediaMimetype: string | null;
  /**
   * Postgres-only STORED generated tsvector (FTS). Present in `SELECT *` rows read from a Postgres
   * source (and in backups made before it was stripped) but never a real payload column: export drops
   * it, and the import's explicit column list ignores it. Declared so both directions type-check.
   */
  body_ts?: unknown;
}

export interface MessageBatchRow {
  id: string;
  batch_id: string;
  session_id: string;
  status: string;
  messages: string | unknown[];
  options: string | Record<string, unknown> | null;
  progress: string | Record<string, unknown> | null;
  results: string | unknown[] | null;
  current_index: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// templates + baileys_stored_messages both FK sessions ON DELETE CASCADE, so import's
// `DELETE FROM sessions` wipes them; they must be exported and re-inserted or the documented
// backup flow loses them permanently.
export interface TemplateRow {
  id: string;
  sessionId: string;
  name: string;
  body: string;
  header: string | null;
  footer: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BaileysStoredMessageRow {
  id: string;
  sessionId: string;
  waMessageId: string;
  serializedMessage: string;
  createdAt: string;
}

// The persisted lid->phone resolution cache. sessionId names the session whose negative may clear the
// phone; it is not a FK to sessions, so the import's
// `DELETE FROM sessions` never clears it — it must be exported + re-inserted explicitly or a
// backup→restore into a fresh DB loses the whole cache (it self-heals via re-lookup, but lossily).
export interface LidMappingRow {
  isReported?: boolean | number;
  lid: string;
  phone: string | null;
  sessionId: string | null;
  updatedAt: string;
}

export interface ChatStateRow {
  sessionId: string;
  chatId: string;
  muteEndTime: number | null;
  // boolean on Postgres, 0/1 on SQLite; carried through as-is like PluginInstanceRow.enabled.
  archived: boolean | number;
  pinned: boolean | number;
  // Absent from an archive taken before the column existed; null reads as its set fields observed.
  observed?: string | null;
  // Epoch ms WhatsApp deleted the chat; absent from an archive taken before the column existed.
  deletedAt?: number | null;
  updatedAt: string;
}

export interface PluginInstanceRow {
  id: string;
  pluginId: string;
  instanceId: string;
  sessionScope: string | null;
  secret: string;
  verifyToken: string | null;
  config: string | Record<string, unknown> | null;
  enabled: boolean | number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMappingRow {
  id: string;
  sessionId: string;
  chatId: string;
  pluginId: string;
  instanceId: string;
  providerConversationId: string;
  handoverState: string;
  metadata: string | Record<string, unknown> | null;
  updatedAt: string;
}

export interface IngressEventRow {
  id: string;
  instanceId: string;
  pluginId: string;
  providerDeliveryId: string;
  route: string;
  // Retired to NULL once the dispatch outcome is recorded; only 'pending' rows still carry one.
  payload: string | Record<string, unknown> | null;
  payloadHash?: string | null;
  // Dispatch lifecycle (the AddIngressEventDispatchState migration). A restored 'pending' row must
  // keep these or the reconciler never replays it while the dedup row still blocks the provider's
  // retry. Optional because backups exported before the columns existed don't carry them.
  dispatchState?: 'pending' | 'dispatched' | 'failed' | null;
  dispatchAttempts?: number;
  lastDispatchAt?: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface WebhookDeliveryFailureRow {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  url: string;
  idempotencyKey: string | null;
  deliveryId: string | null;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string;
  /** Legacy archives may carry replay data; current exports omit it at the SQL projection. */
  payload?: string | null;
  createdAt: string;
}

export interface WebhookOutboxEventRow {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  idempotencyKey: string;
  deliveryId: string;
  payload: string | null;
  state: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  createdAt: string;
}

export interface IntegrationDeliveryFailureRow {
  id: string;
  direction: string;
  pluginId: string;
  instanceId: string;
  sessionId: string | null;
  deliveryId: string | null;
  attempts: number;
  lastError: string;
  payload: string | Record<string, unknown> | null;
  redriven: boolean | number;
  createdAt: string;
}

// status_updates has no FK to sessions (plain columns), so the import's `DELETE FROM sessions` never
// clears it — it must be exported + re-inserted explicitly like lid_mappings. postedAt/expiresAt are
// bigint epoch-ms: raw queries bypass the entity transformer, so Postgres returns them as strings.
export interface StatusUpdateRow {
  id: string;
  sessionId: string;
  contactJid: string;
  contactName: string | null;
  contactPushName: string | null;
  waStatusId: string;
  type: string;
  caption: string | null;
  mediaPath: string | null;
  mediaMimetype: string | null;
  mediaOmitted: boolean | number;
  omitReason: string | null;
  backgroundColor: string | null;
  font: number | null;
  postedAt: number | string;
  expiresAt: number | string;
}

/**
 * automation_rules has an ON DELETE CASCADE FK to sessions, so the import's `DELETE FROM sessions`
 * takes every rule with it — on SQLite too, where better-sqlite3 enforces foreign keys. Exporting
 * and re-inserting it is therefore not optional: without it a backup/restore silently destroys
 * every autoreply rule. `conditions` is stored as text (the webhook-filter JSON), `enabled` reads
 * back as a boolean on Postgres and 0/1 on SQLite.
 */
export interface AutomationRuleRow {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean | number;
  conditions: string | null;
  replyText: string;
  cooldownSeconds: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/**
 * Team-inbox rows. `inbox_conversations` carries an ON DELETE CASCADE FK to sessions, so the import's
 * `DELETE FROM sessions` wipes it; `inbox_notes` cascades from a conversation. Both must therefore be
 * exported and re-inserted, conversations first, or a restore silently loses every assignment and note.
 */
export interface InboxConversationRow {
  id: string;
  sessionId: string;
  chatId: string;
  status: string;
  assigneeKeyId: string | null;
  assigneeName: string | null;
  divisionId: string | null;
  divisionName: string | null;
  // SLA history. Exported with the row because the deadlines are state, not a derived value: a
  // restore that dropped them would silently forgive every breach recorded before the backup.
  firstInboundAt: string | Date | null;
  firstResponseAt: string | Date | null;
  slaStartedAt: string | Date | null;
  slaDueAt: string | Date | null;
  slaBreachedAt: string | Date | null;
  slaMinutes: number | null;
  resolvedAt: string | Date | null;
  lastInboundAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface InboxNoteRow {
  id: string;
  conversationId: string;
  authorKeyId: string;
  authorName: string;
  body: string;
  createdAt: string | Date;
}

/**
 * Sales-pipeline rows. `crm_stages` is deliberately NOT part of this payload: the migration seeds it
 * with fixed ids on every deployment, so it is configuration rather than backup data, and a restored
 * deal always finds the stage it references. Deals and their append-only activity log are exported,
 * deals first (an activity's `dealId` is a FK to a deal row).
 */
export interface CrmDealRow {
  id: string;
  stageId: string;
  title: string;
  sessionId: string | null;
  chatId: string | null;
  value: number | null;
  currency: string;
  status: string;
  assigneeKeyId: string | null;
  assigneeName: string | null;
  expectedCloseAt: string | Date | null;
  closedAt: string | Date | null;
  notes: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CrmDealActivityRow {
  id: string;
  dealId: string;
  kind: string;
  body: string | null;
  fromStageId: string | null;
  toStageId: string | null;
  authorKeyId: string;
  authorName: string;
  createdAt: string | Date;
}

/**
 * Broadcast rows. The JSON columns arrive as TEXT from the export's raw `SELECT *` (both dialects
 * store `simple-json` as text), so the importer inserts them verbatim; a hand-edited archive that
 * supplies an object is stringified rather than rejected.
 *
 * Recipients are exported after their campaign (the FK), and segments have no FK to anything, so
 * their position in the registry is only about readability.
 */
export interface CampaignRow {
  id: string;
  sessionId: string;
  name: string;
  status: string;
  content: string;
  options: string;
  audience: string;
  progress: string;
  scheduledAt: string | Date | null;
  startedAt: string | Date | null;
  completedAt: string | Date | null;
  createdByKeyId: string | null;
  createdByName: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CampaignRecipientRow {
  id: string;
  campaignId: string;
  chatId: string;
  chatName: string | null;
  status: string;
  batchId: string | null;
  messageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CampaignSegmentRow {
  id: string;
  sessionId: string;
  name: string;
  chatIds: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/**
 * Division routing. Divisions cascade from sessions, agents cascade from a division, and settings
 * and chat states cascade from sessions too — so a restore that skipped them would lose the menu,
 * the membership and every routing decision. Restored in FK order: divisions, agents, settings,
 * then chat states (whose divisionId references a division).
 */
export interface DivisionRow {
  id: string;
  sessionId: string;
  name: string;
  keywords: string;
  menuLabel: string | null;
  welcomeText: string | null;
  sortOrder: number;
  slaMinutes: number;
  isActive: boolean | number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface DivisionAgentRow {
  id: string;
  divisionId: string;
  apiKeyId: string;
  agentName: string;
  createdAt: string | Date;
}

export interface DivisionSettingsRow {
  id: string;
  sessionId: string;
  enabled: boolean | number;
  menuHeader: string | null;
  invalidReply: string | null;
  idleHours: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface DivisionChatStateRow {
  id: string;
  sessionId: string;
  chatId: string;
  status: string;
  divisionId: string | null;
  menuDivisionIds: string | null;
  promptedAt: string | Date | null;
  invalidReplyAt: string | Date | null;
  routedAt: string | Date | null;
  lastInboundAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/**
 * WhatsApp approval workflow rows.
 *
 * None of the three tables has a FK to sessions, so the sessions DELETE never reaches them and the
 * import must clear them explicitly. JSON columns (`metadata`, `coreResponseBody`) arrive as TEXT
 * from the export's raw `SELECT *`, exactly like the campaign columns above.
 *
 * Restore order is identities → requests → commands: a command's `approvalRequestId` points at a
 * request, and a request's authorization depends on the identity mapping.
 */
export interface WhatsAppIdentityRow {
  id: string;
  externalIdentity: string;
  corePersonId: string;
  displayName: string | null;
  isVerified: boolean | number;
  isActive: boolean | number;
  verifiedAt: string | Date | null;
  lastSeenAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface ApprovalRequestRow {
  id: string;
  coreRequestId: string;
  reference: string;
  studentName: string;
  studentClass: string | null;
  dormitoryCoreId: string | null;
  dormitoryName: string | null;
  permitType: string;
  requestedDurationDays: number | null;
  departureAt: string | Date | null;
  expectedReturnAt: string | Date | null;
  status: string;
  coreStatus: string | null;
  targetCorePersonId: string | null;
  targetIdentity: string | null;
  sessionId: string | null;
  notificationMessageId: string | null;
  notificationSentAt: string | Date | null;
  clarificationCount: number;
  decidedAt: string | Date | null;
  decisionSource: string | null;
  lastCommandId: string | null;
  metadata: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface ApprovalCommandRow {
  id: string;
  commandId: string;
  approvalRequestId: string;
  externalMessageId: string;
  decision: string;
  durationDays: number | null;
  status: string;
  attempts: number;
  coreResponseCode: number | null;
  coreResponseBody: string | null;
  errorCode: string | null;
  lastError: string | null;
  lastAttemptAt: string | Date | null;
  nextAttemptAt: string | Date | null;
  sentAt: string | Date | null;
  resolvedAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface MigrationTables {
  sessions: SessionRow[];
  webhooks: WebhookRow[];
  messages: MessageRow[];
  messageBatches: MessageBatchRow[];
  templates: TemplateRow[];
  baileysStoredMessages: BaileysStoredMessageRow[];
  lidMappings: LidMappingRow[];
  chatStates: ChatStateRow[];
  pluginInstances: PluginInstanceRow[];
  conversationMappings: ConversationMappingRow[];
  ingressEvents: IngressEventRow[];
  webhookDeliveryFailures: WebhookDeliveryFailureRow[];
  webhookOutboxEvents: WebhookOutboxEventRow[];
  integrationDeliveryFailures: IntegrationDeliveryFailureRow[];
  statusUpdates: StatusUpdateRow[];
  automationRules: AutomationRuleRow[];
  divisions: DivisionRow[];
  divisionAgents: DivisionAgentRow[];
  divisionSettings: DivisionSettingsRow[];
  divisionChatStates: DivisionChatStateRow[];
  inboxConversations: InboxConversationRow[];
  inboxNotes: InboxNoteRow[];
  crmDeals: CrmDealRow[];
  crmDealActivities: CrmDealActivityRow[];
  campaigns: CampaignRow[];
  campaignRecipients: CampaignRecipientRow[];
  campaignSegments: CampaignSegmentRow[];
  whatsappIdentities: WhatsAppIdentityRow[];
  approvalRequests: ApprovalRequestRow[];
  approvalCommands: ApprovalCommandRow[];
}

export type TableCounts = { [K in keyof MigrationTables]: number };
