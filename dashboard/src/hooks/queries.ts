import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  sessionApi,
  webhookApi,
  templateApi,
  apiKeyApi,
  auditApi,
  infraApi,
  pluginsApi,
  pluginInstancesApi,
  statsApi,
  inboxApi,
  crmApi,
  campaignApi,
  type CreateWebhookRequest,
  type UpdateWebhookRequest,
  type MessageTemplate,
  type TemplatePayload,
  type StatsPeriod,
  type CreateInstanceInput,
  type UpdateInstanceInput,
  type InboxListParams,
  type InboxStatus,
  type CreateCrmDealInput,
  type UpdateCrmDealInput,
  type CreateCampaignInput,
  type UpdateCampaignInput,
  type CampaignStatus,
  type CampaignRecipientStatus,
  type CampaignAudience,
} from '../services/api';

// ── Query Keys ────────────────────────────────────────────────────────

export const queryKeys = {
  sessions: ['sessions'] as const,
  sessionStats: ['sessions', 'stats'] as const,
  sessionGroups: (sessionId: string) => ['sessions', sessionId, 'groups'] as const,
  sessionChats: (sessionId: string) => ['sessions', sessionId, 'chats'] as const,
  webhooks: ['webhooks'] as const,
  templates: (sessionId: string) => ['sessions', sessionId, 'templates'] as const,
  apiKeys: ['apiKeys'] as const,
  logs: (params: { severity?: string; page: number; limit: number }) => ['logs', params] as const,
  infraStatus: ['infra', 'status'] as const,
  plugins: ['plugins'] as const,
  pluginInstances: (pluginId: string) => ['plugins', pluginId, 'instances'] as const,
  engines: ['engines'] as const,
  currentEngine: ['engines', 'current'] as const,
  statsOverview: ['stats', 'overview'] as const,
  statsMessages: (period: string) => ['stats', 'messages', period] as const,
  inbox: (sessionId: string, params: InboxListParams) => ['sessions', sessionId, 'inbox', 'list', params] as const,
  inboxSummary: (sessionId: string) => ['sessions', sessionId, 'inbox', 'summary'] as const,
  inboxConversation: (sessionId: string, chatId: string) =>
    ['sessions', sessionId, 'inbox', 'conversation', chatId] as const,
  agents: ['agents'] as const,
  crmBoard: ['crm', 'board'] as const,
  crmStages: ['crm', 'stages'] as const,
  crmDeal: (id: string) => ['crm', 'deal', id] as const,
  campaigns: (sessionId: string, status?: CampaignStatus) =>
    ['sessions', sessionId, 'campaigns', 'list', status ?? 'all'] as const,
  campaign: (sessionId: string, id: string) => ['sessions', sessionId, 'campaigns', 'detail', id] as const,
  campaignRecipients: (sessionId: string, id: string, status?: CampaignRecipientStatus) =>
    ['sessions', sessionId, 'campaigns', 'recipients', id, status ?? 'all'] as const,
  campaignSegments: (sessionId: string) => ['sessions', sessionId, 'campaigns', 'segments'] as const,
};

// ── Session Queries ───────────────────────────────────────────────────

// `refetchInterval` is for a page that shows live session state with no socket of its own; the pages that read the list
// only to pick a session leave it out. A stale query refetches only on mount, focus or an invalidation. The poll stops
// while its last read was refused (403): a route that refuses the key (one restricted to selected chats is refused
// both reads) would otherwise be refused, and audited as a failed authentication, every interval. A read that
// succeeds again, on focus or mount, starts it again. Any other failure (a proxy 502 while the gateway restarts, a
// timeout) keeps the poll going, so the page does not stay stale with no error shown.
const pollWhileReadable = (interval?: number) =>
  interval === undefined
    ? undefined
    : (query: { state: { error: (Error & { status?: number }) | null } }) =>
        query.state.error?.status === 403 ? false : interval;

export function useSessionsQuery(refetchInterval?: number) {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: sessionApi.list,
    staleTime: 30_000,
    refetchInterval: pollWhileReadable(refetchInterval),
  });
}

export function useSessionStatsQuery(refetchInterval?: number) {
  return useQuery({
    queryKey: queryKeys.sessionStats,
    queryFn: sessionApi.getStats,
    staleTime: 30_000,
    refetchInterval: pollWhileReadable(refetchInterval),
  });
}

export function useSessionGroupsQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionGroups(sessionId),
    queryFn: () => sessionApi.getGroups(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 60_000,
  });
}

export function useSessionChatsQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionChats(sessionId),
    queryFn: ({ signal }) => sessionApi.getChats(sessionId, signal),
    enabled: enabled && !!sessionId,
    staleTime: 60_000,
  });
}

export function useStopSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sessionApi.stop(id),
    // A failed stop can still have changed the session, so the list is re-read either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

// ── Webhook Queries ───────────────────────────────────────────────────

export function useWebhooksQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.webhooks,
    queryFn: webhookApi.listAll,
    staleTime: 30_000,
    enabled,
    // Normalize `events` to an array at the data boundary so every consumer (list render + edit
    // modal) can trust the declared string[] shape. A malformed payload then renders as no tags
    // instead of taking down the whole SPA via events.map() in the ErrorBoundary.
    select: webhooks => webhooks.map(w => ({ ...w, events: Array.isArray(w.events) ? w.events : [] })),
  });
}

export function useCreateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, ...body }: CreateWebhookRequest & { sessionId: string }) =>
      webhookApi.create(sessionId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useUpdateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: UpdateWebhookRequest }) =>
      webhookApi.update(params.sessionId, params.id, params.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useDeleteWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) => webhookApi.delete(params.sessionId, params.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

// ── Template Queries ─────────────────────────────────────────────────────────

export function useTemplatesQuery(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.templates(sessionId),
    queryFn: () => templateApi.list(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 30_000,
  });
}

export function useCreateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; data: TemplatePayload }) =>
      templateApi.create(params.sessionId, params.data),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

export function useUpdateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: Partial<TemplatePayload> }) =>
      templateApi.update(params.sessionId, params.id, params.data),
    onSuccess: (saved, params) => {
      // Swap the saved row into the list before the refetch lands (or fails), so reopening it in the meantime
      // loads the stored values rather than the pre-save ones that a second save would write back.
      queryClient.setQueryData<MessageTemplate[]>(queryKeys.templates(params.sessionId), rows =>
        rows?.map(row => (row.id === params.id ? saved : row)),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

export function useDeleteTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) => templateApi.delete(params.sessionId, params.id),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

// ── API Key Queries ───────────────────────────────────────────────────

export function useApiKeysQuery() {
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: apiKeyApi.list,
    staleTime: 30_000,
  });
}

export function useCreateApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      role: string;
      allowedIps?: string[];
      allowedSessions?: string[];
      allowedChats?: string[];
      expiresAt?: string;
    }) => apiKeyApi.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useUpdateApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: {
        name?: string;
        role?: string;
        allowedIps?: string[];
        allowedSessions?: string[];
        allowedChats?: string[];
        expiresAt?: string | null;
      };
    }) => apiKeyApi.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useDeleteApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.revoke(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

// ── Logs Queries ──────────────────────────────────────────────────────

export function useLogsQuery(params: { severity?: string; page: number; limit: number }) {
  return useQuery({
    queryKey: queryKeys.logs(params),
    queryFn: () =>
      auditApi.list({
        severity: params.severity,
        limit: params.limit,
        offset: (params.page - 1) * params.limit,
      }),
    staleTime: 15_000,
  });
}

// ── Infrastructure Queries ────────────────────────────────────────────

export function useInfraStatusQuery() {
  return useQuery({
    queryKey: queryKeys.infraStatus,
    queryFn: infraApi.getStatus,
    staleTime: 30_000,
  });
}

export function useInfraConfigQuery() {
  return useQuery({
    queryKey: ['infra', 'config'],
    queryFn: infraApi.getConfig,
    staleTime: 30_000,
  });
}

// ── Plugin Queries ────────────────────────────────────────────────────

export function usePluginsQuery() {
  return useQuery({
    queryKey: queryKeys.plugins,
    queryFn: pluginsApi.list,
    staleTime: 30_000,
  });
}

export function usePluginInstancesQuery(pluginId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.pluginInstances(pluginId),
    queryFn: () => pluginInstancesApi.list(pluginId),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateInstanceMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInstanceInput) => pluginInstancesApi.create(pluginId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useRegenerateInstanceSecretMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => pluginInstancesApi.regenerateSecret(pluginId, instanceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useUpdateInstanceMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { instanceId: string; body: UpdateInstanceInput }) =>
      pluginInstancesApi.update(pluginId, params.instanceId, params.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useDeleteInstanceMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => pluginInstancesApi.remove(pluginId, instanceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useEnginesQuery() {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: pluginsApi.getEngines,
    staleTime: 60_000,
  });
}

export function useCurrentEngineQuery() {
  return useQuery({
    queryKey: queryKeys.currentEngine,
    queryFn: pluginsApi.getCurrentEngine,
    staleTime: 60_000,
  });
}

// ── Stats Queries ─────────────────────────────────────────────────────
// /stats/* is ADMIN-only; a non-admin key gets 403 → don't retry, let the UI fall back gracefully.

export function useStatsOverviewQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.statsOverview,
    queryFn: statsApi.getOverview,
    staleTime: 30_000,
    retry: false,
    enabled,
  });
}

export function useStatsMessagesQuery(period: StatsPeriod) {
  return useQuery({
    queryKey: queryKeys.statsMessages(period),
    queryFn: () => statsApi.getMessages(period),
    staleTime: 30_000,
    retry: false,
  });
}

// ── Team Inbox Queries ────────────────────────────────────────────────

/** The assignable agents. Stable for a session, so it is not refetched on focus. */
export function useAgentsQuery() {
  return useQuery({
    queryKey: queryKeys.agents,
    queryFn: inboxApi.agents,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The inbox list polls while it is open: a new message changes the chat list, not a query key. */
export function useInboxQuery(sessionId: string, params: InboxListParams = {}, refetchInterval = 15_000) {
  return useQuery({
    queryKey: queryKeys.inbox(sessionId, params),
    queryFn: () => inboxApi.list(sessionId, params),
    enabled: Boolean(sessionId),
    staleTime: 5_000,
    refetchInterval,
  });
}

export function useInboxSummaryQuery(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.inboxSummary(sessionId),
    queryFn: () => inboxApi.summary(sessionId),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
  });
}

export function useInboxConversationQuery(sessionId: string, chatId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.inboxConversation(sessionId, chatId),
    queryFn: () => inboxApi.get(sessionId, chatId),
    enabled: Boolean(sessionId && chatId) && enabled,
    staleTime: 5_000,
  });
}

/** Invalidate every inbox read for a session after a write. Prefix matching covers list/summary/detail. */
function invalidateInbox(queryClient: ReturnType<typeof useQueryClient>, sessionId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['sessions', sessionId, 'inbox'] });
}

export function useUpdateInboxMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: { status?: InboxStatus; assigneeKeyId?: string | null } }) =>
      inboxApi.update(sessionId, chatId, data),
    onSuccess: () => invalidateInbox(queryClient, sessionId),
  });
}

export function useAddInboxNoteMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, body }: { chatId: string; body: string }) => inboxApi.addNote(sessionId, chatId, body),
    onSuccess: () => invalidateInbox(queryClient, sessionId),
  });
}

export function useDeleteInboxNoteMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, noteId }: { chatId: string; noteId: string }) =>
      inboxApi.deleteNote(sessionId, chatId, noteId),
    onSuccess: () => invalidateInbox(queryClient, sessionId),
  });
}

// ── CRM Pipeline Queries ──────────────────────────────────────────────

/**
 * The whole pipeline. It polls while the page is open so a move made by another agent shows up
 * without a reload; writes also invalidate the prefix, which makes the local update immediate.
 */
export function useCrmBoardQuery(refetchInterval = 20_000) {
  return useQuery({
    queryKey: queryKeys.crmBoard,
    queryFn: crmApi.board,
    staleTime: 5_000,
    refetchInterval,
  });
}

export function useCrmStagesQuery() {
  return useQuery({
    queryKey: queryKeys.crmStages,
    queryFn: crmApi.stages,
    staleTime: 60_000,
  });
}

export function useCrmDealQuery(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.crmDeal(id),
    queryFn: () => crmApi.get(id),
    enabled: Boolean(id) && enabled,
    staleTime: 5_000,
    // The detail dialog holds an editable copy; a focus refetch would replace it mid-edit. Writes
    // invalidate the key explicitly, which is the only refresh the dialog needs.
    refetchOnWindowFocus: false,
  });
}

/** Invalidate every CRM read after a write. Prefix matching covers the board and open detail. */
function invalidateCrm(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['crm'] });
}

export function useCreateCrmDealMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCrmDealInput) => crmApi.create(data),
    onSuccess: () => invalidateCrm(queryClient),
  });
}

export function useUpdateCrmDealMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateCrmDealInput }) => crmApi.update(id, data),
    onSuccess: () => invalidateCrm(queryClient),
  });
}

export function useDeleteCrmDealMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => crmApi.remove(id),
    onSuccess: () => invalidateCrm(queryClient),
  });
}

export function useAddCrmActivityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => crmApi.addActivity(id, body),
    onSuccess: () => invalidateCrm(queryClient),
  });
}

// ── Campaign Queries ──────────────────────────────────────────────────

/** Campaigns for a session. The list polls while the page is open, so a scheduled start shows up. */
export function useCampaignsQuery(sessionId: string, status?: CampaignStatus, refetchInterval = 10_000) {
  return useQuery({
    queryKey: queryKeys.campaigns(sessionId, status),
    queryFn: () => campaignApi.list(sessionId, { status }),
    enabled: Boolean(sessionId),
    staleTime: 3_000,
    refetchInterval,
  });
}

/** One campaign. Polls faster while it is running, because progress changes per chunk. */
export function useCampaignQuery(sessionId: string, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.campaign(sessionId, id),
    queryFn: () => campaignApi.get(sessionId, id),
    enabled: Boolean(sessionId) && Boolean(id) && enabled,
    staleTime: 2_000,
    refetchInterval: query => (query.state.data?.status === 'running' ? 3_000 : false),
  });
}

export function useCampaignRecipientsQuery(
  sessionId: string,
  id: string,
  status?: CampaignRecipientStatus,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.campaignRecipients(sessionId, id, status),
    queryFn: () => campaignApi.recipients(sessionId, id, { status, limit: 100 }),
    enabled: Boolean(sessionId) && Boolean(id) && enabled,
    staleTime: 2_000,
    refetchInterval: query => (query.state.data?.some(row => row.status === 'pending') ? 4_000 : false),
  });
}

export function useCampaignSegmentsQuery(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.campaignSegments(sessionId),
    queryFn: () => campaignApi.segments(sessionId),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  });
}

function invalidateCampaigns(queryClient: ReturnType<typeof useQueryClient>, sessionId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['sessions', sessionId, 'campaigns'] });
}

export function useCreateCampaignMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCampaignInput) => campaignApi.create(sessionId, data),
    onSuccess: () => invalidateCampaigns(queryClient, sessionId),
  });
}

export function useUpdateCampaignMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateCampaignInput }) => campaignApi.update(sessionId, id, data),
    onSuccess: () => invalidateCampaigns(queryClient, sessionId),
  });
}

export function useDeleteCampaignMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => campaignApi.remove(sessionId, id),
    onSuccess: () => invalidateCampaigns(queryClient, sessionId),
  });
}

export function useStartCampaignMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => campaignApi.start(sessionId, id),
    onSuccess: () => invalidateCampaigns(queryClient, sessionId),
  });
}

export function useCancelCampaignMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => campaignApi.cancel(sessionId, id),
    onSuccess: () => invalidateCampaigns(queryClient, sessionId),
  });
}

export function useCreateCampaignSegmentMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; chatIds: string[] }) => campaignApi.createSegment(sessionId, data),
    onSuccess: () => invalidateCampaigns(queryClient, sessionId),
  });
}

export function useDeleteCampaignSegmentMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => campaignApi.removeSegment(sessionId, id),
    onSuccess: () => invalidateCampaigns(queryClient, sessionId),
  });
}

/** Resolve an audience for the wizard's preview step. A mutation, because it is an explicit action. */
export function usePreviewCampaignAudienceMutation(sessionId: string) {
  return useMutation({
    mutationFn: (audience: CampaignAudience) => campaignApi.preview(sessionId, audience),
  });
}
