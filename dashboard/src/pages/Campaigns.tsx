import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Megaphone, Play, Plus, Search, Square, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useCancelCampaignMutation,
  useCampaignQuery,
  useCampaignRecipientsQuery,
  useCampaignSegmentsQuery,
  useCampaignsQuery,
  useCreateCampaignMutation,
  useCreateCampaignSegmentMutation,
  useDeleteCampaignMutation,
  usePreviewCampaignAudienceMutation,
  useSessionChatsQuery,
  useSessionsQuery,
  useStartCampaignMutation,
} from '../hooks/queries';
import type {
  Campaign,
  CampaignAudience,
  CampaignAudienceKind,
  CampaignContent,
  CampaignContentBody,
  CampaignMessageType,
  CampaignRecipientStatus,
  CampaignStatus,
} from '../services/api';
import './Campaigns.css';

const STATUS_FILTERS: Array<CampaignStatus | 'all'> = [
  'all',
  'draft',
  'scheduled',
  'running',
  'completed',
  'cancelled',
  'failed',
];
const MESSAGE_TYPES: CampaignMessageType[] = ['text', 'image', 'video', 'audio', 'document'];
const AUDIENCE_KINDS: CampaignAudienceKind[] = ['manual', 'segment', 'all', 'label'];
const RECIPIENT_FILTERS: Array<CampaignRecipientStatus | 'all'> = ['all', 'pending', 'sent', 'failed', 'skipped'];

interface CampaignForm {
  name: string;
  type: CampaignMessageType;
  text: string;
  mediaUrl: string;
  caption: string;
  mimetype: string;
  filename: string;
  audienceKind: CampaignAudienceKind;
  segmentId: string;
  labelId: string;
  chatIds: string[];
  delayBetweenMessages: string;
  randomizeDelay: boolean;
  stopOnError: boolean;
  scheduledAt: string;
}

const EMPTY_FORM: CampaignForm = {
  name: '',
  type: 'text',
  text: '',
  mediaUrl: '',
  caption: '',
  mimetype: '',
  filename: '',
  audienceKind: 'manual',
  segmentId: '',
  labelId: '',
  chatIds: [],
  delayBetweenMessages: '3000',
  randomizeDelay: true,
  stopOnError: false,
  scheduledAt: '',
};

function buildContent(form: CampaignForm): CampaignContent {
  if (form.type === 'text') return { type: 'text', content: { text: form.text } };

  const media = {
    url: form.mediaUrl,
    caption: form.caption || undefined,
    mimetype: form.mimetype || undefined,
  };
  const body: CampaignContentBody = { caption: form.caption || undefined };
  switch (form.type) {
    case 'image':
      body.image = media;
      break;
    case 'video':
      body.video = media;
      break;
    case 'audio':
      body.audio = media;
      break;
    case 'document':
      body.document = { ...media, filename: form.filename || undefined };
      break;
  }
  return { type: form.type, content: body };
}

function buildAudience(form: CampaignForm): CampaignAudience {
  switch (form.audienceKind) {
    case 'manual':
      return { kind: 'manual', chatIds: form.chatIds };
    case 'segment':
      return { kind: 'segment', segmentId: form.segmentId };
    case 'label':
      return { kind: 'label', labelId: form.labelId };
    case 'all':
      return { kind: 'all' };
  }
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function progressPercent(campaign: Campaign): number {
  if (campaign.progress.total === 0) return 0;
  const done = campaign.progress.sent + campaign.progress.failed + campaign.progress.skipped;
  return Math.min(100, Math.round((done / campaign.progress.total) * 100));
}

/**
 * Broadcast campaigns: the list, a three-step wizard (message → audience → schedule) and a detail
 * dialog with live progress and per-recipient outcomes. Every route is session-scoped, so the page
 * starts from the same session picker the inbox uses.
 */
export function Campaigns() {
  const { t } = useTranslation();
  const toast = useToast();
  const { isAdmin, canWrite } = useRole();
  useDocumentTitle(t('campaigns.title'));

  const { data: sessions = [], isLoading: sessionsLoading } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');

  useEffect(() => {
    if (sessionId || sessions.length === 0) return;
    const ready = sessions.find(session => session.status === 'ready') ?? sessions[0];
    setSessionId(ready.id);
  }, [sessionId, sessions]);

  const campaigns = useCampaignsQuery(sessionId, statusFilter === 'all' ? undefined : statusFilter);

  const [createOpen, setCreateOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<CampaignForm>(EMPTY_FORM);
  const [chatSearch, setChatSearch] = useState('');
  const [segmentName, setSegmentName] = useState('');

  const chats = useSessionChatsQuery(sessionId, createOpen);
  const segments = useCampaignSegmentsQuery(sessionId);
  const createCampaign = useCreateCampaignMutation(sessionId);
  const createSegment = useCreateCampaignSegmentMutation(sessionId);
  const preview = usePreviewCampaignAudienceMutation(sessionId);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setStep(1);
    setChatSearch('');
    setSegmentName('');
    preview.reset();
    setCreateOpen(true);
  };

  const update = <K extends keyof CampaignForm>(key: K, value: CampaignForm[K]) =>
    setForm(current => ({ ...current, [key]: value }));

  const toggleChat = (chatId: string) =>
    setForm(current => ({
      ...current,
      chatIds: current.chatIds.includes(chatId)
        ? current.chatIds.filter(id => id !== chatId)
        : [...current.chatIds, chatId],
    }));

  const filteredChats = useMemo(() => {
    const term = chatSearch.trim().toLowerCase();
    const rows = chats.data ?? [];
    if (!term) return rows.slice(0, 200);
    return rows
      .filter(chat => chat.name.toLowerCase().includes(term) || chat.id.toLowerCase().includes(term))
      .slice(0, 200);
  }, [chats.data, chatSearch]);

  const audience = buildAudience(form);
  const content = buildContent(form);

  const contentValid = form.type === 'text' ? form.text.trim().length > 0 : form.mediaUrl.trim().length > 0;
  const audienceValid =
    form.audienceKind === 'manual'
      ? form.chatIds.length > 0
      : form.audienceKind === 'segment'
        ? Boolean(form.segmentId)
        : form.audienceKind === 'label'
          ? Boolean(form.labelId)
          : true;

  const submit = () => {
    if (!form.name.trim() || !contentValid) return;
    createCampaign.mutate(
      {
        name: form.name.trim(),
        content,
        audience,
        options: {
          delayBetweenMessages: Number.parseInt(form.delayBetweenMessages, 10) || 3000,
          randomizeDelay: form.randomizeDelay,
          stopOnError: form.stopOnError,
        },
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
      },
      {
        onSuccess: () => {
          toast.success(t('campaigns.toast.created'));
          setCreateOpen(false);
        },
        onError: error => toast.error(error instanceof Error ? error.message : t('campaigns.toast.failed')),
      },
    );
  };

  const saveSegment = () => {
    const name = segmentName.trim();
    if (!name || form.chatIds.length === 0) return;
    createSegment.mutate(
      { name, chatIds: form.chatIds },
      {
        onSuccess: segment => {
          toast.success(t('campaigns.toast.segmentSaved'));
          setSegmentName('');
          update('segmentId', segment.id);
        },
        onError: error => toast.error(error instanceof Error ? error.message : t('campaigns.toast.failed')),
      },
    );
  };

  const rows = (campaigns.data ?? []).filter(row =>
    search.trim() ? row.name.toLowerCase().includes(search.trim().toLowerCase()) : true,
  );

  return (
    <div className="campaigns-page">
      <PageHeader
        title={t('campaigns.title')}
        subtitle={t('campaigns.subtitle')}
        actions={
          <button type="button" className="btn btn-primary" onClick={openCreate} disabled={!sessionId || !canWrite}>
            <Plus size={16} />
            {t('campaigns.new')}
          </button>
        }
      />

      <div className="campaigns-toolbar">
        <label className="campaigns-session">
          <span>{t('campaigns.session')}</span>
          <select value={sessionId} onChange={event => setSessionId(event.target.value)} disabled={sessionsLoading}>
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name} ({session.id})
              </option>
            ))}
          </select>
        </label>

        <label className="campaigns-status-filter">
          <span>{t('campaigns.status')}</span>
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as CampaignStatus | 'all')}
          >
            {STATUS_FILTERS.map(value => (
              <option key={value} value={value}>
                {value === 'all' ? t('campaigns.allStatuses') : t(`campaigns.status.${value}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="campaigns-search">
          <Search size={15} />
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('campaigns.searchPlaceholder')}
          />
        </label>
      </div>

      {campaigns.isError && (
        <div className="campaigns-error">
          <AlertCircle size={16} />
          {t('campaigns.error.load')}
        </div>
      )}

      {campaigns.isLoading ? (
        <div className="campaigns-empty">
          <Loader2 size={18} className="spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="campaigns-empty">
          <Megaphone size={28} />
          <p>{t('campaigns.empty')}</p>
        </div>
      ) : (
        <div className="campaigns-table-wrap">
          <table className="campaigns-table">
            <thead>
              <tr>
                <th>{t('campaigns.name')}</th>
                <th>{t('campaigns.status')}</th>
                <th>{t('campaigns.audience')}</th>
                <th>{t('campaigns.progress')}</th>
                <th>{t('campaigns.createdAt')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} onClick={() => setSelectedId(row.id)} className="campaigns-row">
                  <td className="campaigns-name">{row.name}</td>
                  <td>
                    <span className={`campaign-status campaign-status--${row.status}`}>
                      {t(`campaigns.status.${row.status}`)}
                    </span>
                  </td>
                  <td>{t(`campaigns.audienceKind.${row.audience.kind}`)}</td>
                  <td>
                    <div className="campaign-progress">
                      <div className="campaign-progress__bar">
                        <span style={{ width: `${progressPercent(row)}%` }} />
                      </div>
                      <span className="campaign-progress__label">
                        {row.progress.sent + row.progress.failed + row.progress.skipped}/{row.progress.total}
                      </span>
                    </div>
                  </td>
                  <td>{formatDate(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CampaignWizard
        open={createOpen}
        step={step}
        setStep={setStep}
        form={form}
        update={update}
        chats={filteredChats}
        chatSearch={chatSearch}
        setChatSearch={setChatSearch}
        toggleChat={toggleChat}
        segments={segments.data ?? []}
        segmentName={segmentName}
        setSegmentName={setSegmentName}
        saveSegment={saveSegment}
        preview={preview}
        contentValid={contentValid}
        audienceValid={audienceValid}
        submitting={createCampaign.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={submit}
        onPreview={() => preview.mutate(audience)}
      />

      <CampaignDetailDialog
        sessionId={sessionId}
        campaignId={selectedId}
        isAdmin={isAdmin}
        canWrite={canWrite}
        onClose={() => setSelectedId('')}
      />
    </div>
  );
}

interface WizardProps {
  open: boolean;
  step: number;
  setStep: (step: number) => void;
  form: CampaignForm;
  update: <K extends keyof CampaignForm>(key: K, value: CampaignForm[K]) => void;
  chats: Array<{ id: string; name: string; isGroup: boolean }>;
  chatSearch: string;
  setChatSearch: (value: string) => void;
  toggleChat: (chatId: string) => void;
  segments: Array<{ id: string; name: string; chatIds: string[] }>;
  segmentName: string;
  setSegmentName: (value: string) => void;
  saveSegment: () => void;
  preview: ReturnType<typeof usePreviewCampaignAudienceMutation>;
  contentValid: boolean;
  audienceValid: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onPreview: () => void;
}

function CampaignWizard({
  open,
  step,
  setStep,
  form,
  update,
  chats,
  chatSearch,
  setChatSearch,
  toggleChat,
  segments,
  segmentName,
  setSegmentName,
  saveSegment,
  preview,
  contentValid,
  audienceValid,
  submitting,
  onClose,
  onSubmit,
  onPreview,
}: WizardProps) {
  const { t } = useTranslation();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('campaigns.wizard.title')}
      className="campaign-wizard-modal"
      footer={
        <div className="campaign-wizard-footer">
          {step > 1 && (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              {t('campaigns.wizard.back')}
            </button>
          )}
          {step < 3 ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStep(step + 1)}
              disabled={step === 1 ? !contentValid : !audienceValid}
            >
              {t('campaigns.wizard.next')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSubmit}
              disabled={submitting || !contentValid || !audienceValid}
            >
              {submitting && <Loader2 size={15} className="spin" />}
              {t('campaigns.wizard.create')}
            </button>
          )}
        </div>
      }
    >
      <ol className="campaign-steps">
        {[1, 2, 3].map(value => (
          <li key={value} className={value === step ? 'is-active' : value < step ? 'is-done' : ''}>
            <span>{value}</span>
            {t(`campaigns.wizard.step${value}`)}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="campaign-form">
          <label>
            <span>{t('campaigns.form.name')}</span>
            <input
              value={form.name}
              onChange={event => update('name', event.target.value)}
              placeholder={t('campaigns.form.namePlaceholder')}
              maxLength={120}
            />
          </label>

          <label>
            <span>{t('campaigns.form.type')}</span>
            <select value={form.type} onChange={event => update('type', event.target.value as CampaignMessageType)}>
              {MESSAGE_TYPES.map(type => (
                <option key={type} value={type}>
                  {t(`campaigns.messageType.${type}`)}
                </option>
              ))}
            </select>
          </label>

          {form.type === 'text' ? (
            <label>
              <span>{t('campaigns.form.message')}</span>
              <textarea
                value={form.text}
                onChange={event => update('text', event.target.value)}
                rows={6}
                placeholder={t('campaigns.form.messagePlaceholder')}
              />
              <small>{t('campaigns.form.variablesHint')}</small>
            </label>
          ) : (
            <>
              <label>
                <span>{t('campaigns.form.mediaUrl')}</span>
                <input value={form.mediaUrl} onChange={event => update('mediaUrl', event.target.value)} />
              </label>
              <label>
                <span>{t('campaigns.form.caption')}</span>
                <input value={form.caption} onChange={event => update('caption', event.target.value)} />
                <small>{t('campaigns.form.variablesHint')}</small>
              </label>
              <div className="campaign-form-row">
                <label>
                  <span>{t('campaigns.form.mimetype')}</span>
                  <input value={form.mimetype} onChange={event => update('mimetype', event.target.value)} />
                </label>
                {form.type === 'document' && (
                  <label>
                    <span>{t('campaigns.form.filename')}</span>
                    <input value={form.filename} onChange={event => update('filename', event.target.value)} />
                  </label>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="campaign-form">
          <label>
            <span>{t('campaigns.form.audienceKind')}</span>
            <select
              value={form.audienceKind}
              onChange={event => update('audienceKind', event.target.value as CampaignAudienceKind)}
            >
              {AUDIENCE_KINDS.map(kind => (
                <option key={kind} value={kind}>
                  {t(`campaigns.audienceKind.${kind}`)}
                </option>
              ))}
            </select>
          </label>

          {form.audienceKind === 'all' && <p className="campaign-hint">{t('campaigns.form.allHint')}</p>}

          {form.audienceKind === 'label' && (
            <>
              <label>
                <span>{t('campaigns.form.labelId')}</span>
                <input value={form.labelId} onChange={event => update('labelId', event.target.value)} />
              </label>
              <p className="campaign-hint">{t('campaigns.form.labelHint')}</p>
            </>
          )}

          {form.audienceKind === 'segment' && (
            <label>
              <span>{t('campaigns.form.segment')}</span>
              <select value={form.segmentId} onChange={event => update('segmentId', event.target.value)}>
                <option value="">{t('campaigns.none')}</option>
                {segments.map(segment => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name} ({segment.chatIds.length})
                  </option>
                ))}
              </select>
            </label>
          )}

          {form.audienceKind === 'manual' && (
            <>
              <div className="campaign-chat-search">
                <Search size={15} />
                <input
                  value={chatSearch}
                  onChange={event => setChatSearch(event.target.value)}
                  placeholder={t('campaigns.form.searchChats')}
                />
                <span>{t('campaigns.form.selected', { count: form.chatIds.length })}</span>
              </div>
              <div className="campaign-chat-list">
                {chats.map(chat => (
                  <label key={chat.id} className="campaign-chat-row">
                    <input
                      type="checkbox"
                      checked={form.chatIds.includes(chat.id)}
                      onChange={() => toggleChat(chat.id)}
                    />
                    <span className="campaign-chat-name">{chat.name || chat.id}</span>
                    <span className="campaign-chat-id">{chat.id}</span>
                  </label>
                ))}
              </div>
              <div className="campaign-segment-save">
                <input
                  value={segmentName}
                  onChange={event => setSegmentName(event.target.value)}
                  placeholder={t('campaigns.form.segmentName')}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={saveSegment}
                  disabled={!segmentName.trim() || form.chatIds.length === 0}
                >
                  {t('campaigns.form.saveSegment')}
                </button>
              </div>
            </>
          )}

          <div className="campaign-preview">
            <button type="button" className="btn" onClick={onPreview} disabled={!audienceValid || preview.isPending}>
              {preview.isPending && <Loader2 size={15} className="spin" />}
              {t('campaigns.form.preview')}
            </button>
            {preview.data && (
              <div className="campaign-preview-result">
                <strong>{t('campaigns.form.previewCount', { count: preview.data.count })}</strong>
                {preview.data.truncated && <span>{t('campaigns.form.previewTruncated')}</span>}
                <ul>
                  {preview.data.sample.slice(0, 5).map(sample => (
                    <li key={sample.chatId}>{sample.chatName || sample.chatId}</li>
                  ))}
                </ul>
              </div>
            )}
            {preview.isError && (
              <span className="campaign-preview-error">
                {preview.error instanceof Error ? preview.error.message : t('campaigns.toast.failed')}
              </span>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="campaign-form">
          <div className="campaign-form-row">
            <label>
              <span>{t('campaigns.form.delay')}</span>
              <input
                type="number"
                min={1000}
                max={60000}
                step={500}
                value={form.delayBetweenMessages}
                onChange={event => update('delayBetweenMessages', event.target.value)}
              />
            </label>
            <label>
              <span>{t('campaigns.form.schedule')}</span>
              <input
                type="datetime-local"
                value={form.scheduledAt}
                onChange={event => update('scheduledAt', event.target.value)}
              />
            </label>
          </div>

          <label className="campaign-checkbox">
            <input
              type="checkbox"
              checked={form.randomizeDelay}
              onChange={event => update('randomizeDelay', event.target.checked)}
            />
            {t('campaigns.form.randomize')}
          </label>
          <label className="campaign-checkbox">
            <input
              type="checkbox"
              checked={form.stopOnError}
              onChange={event => update('stopOnError', event.target.checked)}
            />
            {t('campaigns.form.stopOnError')}
          </label>

          <p className="campaign-hint">{t('campaigns.form.scheduleHint')}</p>
        </div>
      )}
    </Modal>
  );
}

interface DetailProps {
  sessionId: string;
  campaignId: string;
  isAdmin: boolean;
  canWrite: boolean;
  onClose: () => void;
}

function CampaignDetailDialog({ sessionId, campaignId, isAdmin, canWrite, onClose }: DetailProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const detail = useCampaignQuery(sessionId, campaignId, Boolean(campaignId));
  const [recipientFilter, setRecipientFilter] = useState<CampaignRecipientStatus | 'all'>('all');
  const recipients = useCampaignRecipientsQuery(
    sessionId,
    campaignId,
    recipientFilter === 'all' ? undefined : recipientFilter,
    Boolean(campaignId),
  );
  const start = useStartCampaignMutation(sessionId);
  const cancel = useCancelCampaignMutation(sessionId);
  const remove = useDeleteCampaignMutation(sessionId);

  const campaign = detail.data;
  const canStart = campaign?.status === 'draft' || campaign?.status === 'scheduled';
  const canCancel = campaign?.status === 'draft' || campaign?.status === 'scheduled' || campaign?.status === 'running';
  const canDelete = isAdmin && (campaign?.status === 'draft' || campaign?.status === 'cancelled');

  const onError = (error: unknown) => toast.error(error instanceof Error ? error.message : t('campaigns.toast.failed'));

  return (
    <Modal
      open={Boolean(campaignId)}
      onClose={onClose}
      title={campaign?.name ?? t('campaigns.detail.title')}
      className="campaign-detail-modal"
      footer={
        campaign && (
          <div className="campaign-detail-footer">
            {canStart && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canWrite || start.isPending}
                onClick={() =>
                  start.mutate(campaign.id, {
                    onSuccess: () => toast.success(t('campaigns.toast.started')),
                    onError,
                  })
                }
              >
                <Play size={15} />
                {t('campaigns.detail.start')}
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                className="btn"
                disabled={!canWrite || cancel.isPending}
                onClick={() =>
                  cancel.mutate(campaign.id, {
                    onSuccess: () => toast.success(t('campaigns.toast.cancelled')),
                    onError,
                  })
                }
              >
                <Square size={15} />
                {t('campaigns.detail.cancel')}
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (!window.confirm(t('campaigns.detail.confirmDelete'))) return;
                  remove.mutate(campaign.id, {
                    onSuccess: () => {
                      toast.success(t('campaigns.toast.deleted'));
                      onClose();
                    },
                    onError,
                  });
                }}
              >
                <Trash2 size={15} />
                {t('campaigns.detail.delete')}
              </button>
            )}
          </div>
        )
      }
    >
      {detail.isLoading || !campaign ? (
        <div className="campaigns-empty">
          <Loader2 size={18} className="spin" />
        </div>
      ) : (
        <div className="campaign-detail">
          <div className="campaign-detail-meta">
            <span className={`campaign-status campaign-status--${campaign.status}`}>
              {t(`campaigns.status.${campaign.status}`)}
            </span>
            <span>{t(`campaigns.audienceKind.${campaign.audience.kind}`)}</span>
            {campaign.scheduledAt && <span>{formatDate(campaign.scheduledAt)}</span>}
            {campaign.createdByName && <span>{campaign.createdByName}</span>}
          </div>

          <div className="campaign-progress campaign-progress--large">
            <div className="campaign-progress__bar">
              <span style={{ width: `${progressPercent(campaign)}%` }} />
            </div>
            <div className="campaign-detail-stats">
              <span>
                {t('campaigns.detail.sent')}: <strong>{campaign.progress.sent}</strong>
              </span>
              <span>
                {t('campaigns.detail.failed')}: <strong>{campaign.progress.failed}</strong>
              </span>
              <span>
                {t('campaigns.detail.skipped')}: <strong>{campaign.progress.skipped}</strong>
              </span>
              <span>
                {t('campaigns.detail.total')}: <strong>{campaign.progress.total}</strong>
              </span>
            </div>
          </div>

          <div className="campaign-detail-recipients">
            <div className="campaign-detail-recipients-head">
              <h3>{t('campaigns.detail.recipients')}</h3>
              <select
                aria-label={t('campaigns.detail.recipients')}
                value={recipientFilter}
                onChange={event => setRecipientFilter(event.target.value as CampaignRecipientStatus | 'all')}
              >
                {RECIPIENT_FILTERS.map(value => (
                  <option key={value} value={value}>
                    {value === 'all' ? t('campaigns.allStatuses') : t(`campaigns.recipientStatus.${value}`)}
                  </option>
                ))}
              </select>
            </div>

            {(recipients.data ?? []).length === 0 ? (
              <p className="campaign-hint">{t('campaigns.detail.noRecipients')}</p>
            ) : (
              <table className="campaign-recipient-table">
                <thead>
                  <tr>
                    <th>{t('campaigns.detail.chat')}</th>
                    <th>{t('campaigns.status')}</th>
                    <th>{t('campaigns.detail.error')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(recipients.data ?? []).map(row => (
                    <tr key={row.chatId}>
                      <td>
                        <div className="campaign-recipient-name">{row.chatName || row.chatId}</div>
                        {row.chatName && <div className="campaign-chat-id">{row.chatId}</div>}
                      </td>
                      <td>
                        <span className={`campaign-status campaign-status--${row.status}`}>
                          {t(`campaigns.recipientStatus.${row.status}`)}
                        </span>
                      </td>
                      <td className="campaign-recipient-error">{row.errorMessage ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
