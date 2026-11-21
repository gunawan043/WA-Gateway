import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CalendarClock, Loader2, Plus, Search, Trash2, User } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useAddCrmActivityMutation,
  useAgentsQuery,
  useCreateCrmDealMutation,
  useCrmBoardQuery,
  useCrmDealQuery,
  useDeleteCrmDealMutation,
  useUpdateCrmDealMutation,
} from '../hooks/queries';
import type { CrmAssigneeFilter, CrmDeal, CrmDealDetail } from '../services/api';
import './Pipeline.css';

function formatMoney(value: number | null, currency: string): string {
  if (value === null) return '';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'IDR',
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value.toLocaleString()} ${currency}`;
  }
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

/** Local `YYYY-MM-DD` for an `<input type="date">`, without shifting the day across time zones. */
function toDateInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

interface DealForm {
  title: string;
  stageId: string;
  value: string;
  currency: string;
  assigneeKeyId: string;
  expectedCloseAt: string;
  notes: string;
}

const EMPTY_FORM: DealForm = {
  title: '',
  stageId: '',
  value: '',
  currency: 'IDR',
  assigneeKeyId: '',
  expectedCloseAt: '',
  notes: '',
};

function formFromDeal(deal: CrmDealDetail): DealForm {
  return {
    title: deal.title,
    stageId: deal.stageId,
    value: deal.value === null ? '' : String(deal.value),
    currency: deal.currency,
    assigneeKeyId: deal.assigneeKeyId ?? '',
    expectedCloseAt: toDateInput(deal.expectedCloseAt),
    notes: deal.notes ?? '',
  };
}

/**
 * Sales pipeline board. Columns are the seeded stages; dragging a card onto another column moves the
 * deal there, and the server derives open/won/lost from the stage, so the status badge can never
 * disagree with the column a card sits in. The detail dialog offers the same move as a select for
 * keyboard and touch use.
 */
export function Pipeline() {
  const { t } = useTranslation();
  const toast = useToast();
  const { keyId, keyName, canWrite, isAdmin } = useRole();
  useDocumentTitle(t('pipeline.title'));

  const board = useCrmBoardQuery();
  const { data: agents = [] } = useAgentsQuery();
  const createDeal = useCreateCrmDealMutation();
  const updateDeal = useUpdateCrmDealMutation();
  const deleteDeal = useDeleteCrmDealMutation();
  const addActivity = useAddCrmActivityMutation();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [assignee, setAssignee] = useState<CrmAssigneeFilter>('all');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<DealForm>(EMPTY_FORM);
  const [detailForm, setDetailForm] = useState<DealForm>(EMPTY_FORM);
  const [noteDraft, setNoteDraft] = useState('');

  const detail = useCrmDealQuery(selectedId, Boolean(selectedId));

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (detail.data) {
      setDetailForm(formFromDeal(detail.data));
      setNoteDraft('');
    }
  }, [detail.data]);

  const stages = board.data?.columns.map(column => column.stage) ?? [];
  const stageName = (id: string | null): string => stages.find(stage => stage.id === id)?.name ?? '';

  const matches = (deal: CrmDeal): boolean => {
    if (assignee === 'unassigned' && deal.assigneeKeyId !== null) return false;
    if (assignee === 'me' && (!keyId || deal.assigneeKeyId !== keyId)) return false;
    if (assignee !== 'all' && assignee !== 'me' && assignee !== 'unassigned' && deal.assigneeKeyId !== assignee) {
      return false;
    }
    if (!debouncedSearch) return true;
    return (
      deal.title.toLowerCase().includes(debouncedSearch) ||
      (deal.notes ?? '').toLowerCase().includes(debouncedSearch) ||
      (deal.assigneeName ?? '').toLowerCase().includes(debouncedSearch)
    );
  };

  const filtered = (board.data?.columns ?? []).map(column => ({
    stage: column.stage,
    deals: column.deals.filter(matches),
  }));

  const move = (dealId: string, stageId: string) => {
    const current = board.data?.columns.flatMap(column => column.deals).find(deal => deal.id === dealId);
    if (!current || current.stageId === stageId) return;
    updateDeal.mutate(
      { id: dealId, data: { stageId } },
      {
        onSuccess: () => toast.success(t('pipeline.toast.moved', { stage: stageName(stageId) })),
        onError: error => toast.error(error instanceof Error ? error.message : t('pipeline.toast.saveFailed')),
      },
    );
  };

  const openCreate = () => {
    setCreateForm({ ...EMPTY_FORM, stageId: stages[0]?.id ?? '' });
    setCreating(true);
  };

  const submitCreate = () => {
    if (!createForm.title.trim()) return;
    createDeal.mutate(
      {
        title: createForm.title.trim(),
        stageId: createForm.stageId || undefined,
        value: createForm.value === '' ? null : Number(createForm.value),
        currency: createForm.currency.trim().toUpperCase() || 'IDR',
        assigneeKeyId: createForm.assigneeKeyId || null,
        expectedCloseAt: createForm.expectedCloseAt || null,
        notes: createForm.notes.trim() || null,
      },
      {
        onSuccess: () => {
          setCreating(false);
          setCreateForm(EMPTY_FORM);
          toast.success(t('pipeline.toast.created'));
        },
        onError: error => toast.error(error instanceof Error ? error.message : t('pipeline.toast.saveFailed')),
      },
    );
  };

  const submitDetail = () => {
    if (!selectedId || !detailForm.title.trim()) return;
    updateDeal.mutate(
      {
        id: selectedId,
        data: {
          title: detailForm.title.trim(),
          stageId: detailForm.stageId,
          value: detailForm.value === '' ? null : Number(detailForm.value),
          currency: detailForm.currency.trim().toUpperCase() || 'IDR',
          assigneeKeyId: detailForm.assigneeKeyId || null,
          expectedCloseAt: detailForm.expectedCloseAt || null,
          notes: detailForm.notes.trim() || null,
        },
      },
      {
        onSuccess: () => toast.success(t('pipeline.toast.updated')),
        onError: error => toast.error(error instanceof Error ? error.message : t('pipeline.toast.saveFailed')),
      },
    );
  };

  const submitNote = () => {
    const body = noteDraft.trim();
    if (!body || !selectedId) return;
    addActivity.mutate(
      { id: selectedId, body },
      {
        onSuccess: () => {
          setNoteDraft('');
          toast.success(t('pipeline.toast.noteAdded'));
        },
        onError: error => toast.error(error instanceof Error ? error.message : t('pipeline.toast.saveFailed')),
      },
    );
  };

  const removeDeal = () => {
    if (!selectedId || !window.confirm(t('pipeline.deal.confirmDelete'))) return;
    deleteDeal.mutate(selectedId, {
      onSuccess: () => {
        setSelectedId('');
        toast.success(t('pipeline.toast.deleted'));
      },
      onError: error => toast.error(error instanceof Error ? error.message : t('pipeline.toast.saveFailed')),
    });
  };

  const renderAssigneeOptions = () => (
    <>
      <option value="">{t('pipeline.unassigned')}</option>
      {keyId && <option value={keyId}>{t('pipeline.assignToMe', { name: keyName ?? '' })}</option>}
      {agents
        .filter(agent => agent.id !== keyId)
        .map(agent => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
    </>
  );

  return (
    <div className="pipeline-page">
      <PageHeader
        title={t('pipeline.title')}
        subtitle={t('pipeline.subtitle')}
        actions={
          <div className="pipeline-header-actions">
            <div className="pipeline-search">
              <Search size={16} />
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder={t('pipeline.searchPlaceholder')}
              />
            </div>
            <select
              value={assignee}
              onChange={event => setAssignee(event.target.value)}
              aria-label={t('pipeline.assignee')}
            >
              <option value="all">{t('pipeline.allAgents')}</option>
              <option value="me">{t('pipeline.assignedToMe')}</option>
              <option value="unassigned">{t('pipeline.unassigned')}</option>
            </select>
            {canWrite && (
              <button type="button" className="pipeline-primary" onClick={openCreate}>
                <Plus size={16} />
                {t('pipeline.newDeal')}
              </button>
            )}
          </div>
        }
      />

      {board.isLoading ? (
        <div className="pipeline-state">
          <Loader2 className="animate-spin" size={24} />
        </div>
      ) : board.isError ? (
        <div className="pipeline-state pipeline-error">
          <AlertCircle size={22} />
          <p>{t('pipeline.error.load')}</p>
        </div>
      ) : (
        <>
          <div className="pipeline-stats">
            <span>
              <strong>{board.data?.open ?? 0}</strong> {t('pipeline.stats.open')}
            </span>
            <span>
              <strong>{board.data?.won ?? 0}</strong> {t('pipeline.stats.won')}
            </span>
            <span>
              <strong>{board.data?.lost ?? 0}</strong> {t('pipeline.stats.lost')}
            </span>
            <span>
              <strong>{(board.data?.openValue ?? 0).toLocaleString()}</strong> {t('pipeline.stats.openValue')}
            </span>
          </div>

          <div className="pipeline-board">
            {filtered.map(({ stage, deals }) => (
              <section
                key={stage.id}
                className={`pipeline-column${draggingId ? ' is-drop-target' : ''}`}
                aria-label={stage.name}
                onDragOver={event => {
                  if (canWrite) event.preventDefault();
                }}
                onDrop={event => {
                  event.preventDefault();
                  const dealId = event.dataTransfer.getData('text/plain') || draggingId;
                  setDraggingId(null);
                  if (canWrite && dealId) move(dealId, stage.id);
                }}
              >
                <header
                  className="pipeline-column-header"
                  style={stage.color ? { borderTopColor: stage.color } : undefined}
                >
                  <h2>{stage.name}</h2>
                  <span className="pipeline-column-count">{deals.length}</span>
                  <span className="pipeline-column-value">
                    {formatMoney(
                      deals.reduce((sum, deal) => sum + (deal.value ?? 0), 0),
                      deals[0]?.currency ?? 'IDR',
                    )}
                  </span>
                </header>

                <div className="pipeline-column-body">
                  {deals.length === 0 ? (
                    <p className="pipeline-column-empty">{t('pipeline.columnEmpty')}</p>
                  ) : (
                    deals.map(deal => (
                      <article
                        key={deal.id}
                        className={`pipeline-card${draggingId === deal.id ? ' is-dragging' : ''}`}
                        draggable={canWrite}
                        onDragStart={event => {
                          event.dataTransfer.setData('text/plain', deal.id);
                          event.dataTransfer.effectAllowed = 'move';
                          setDraggingId(deal.id);
                        }}
                        onDragEnd={() => setDraggingId(null)}
                      >
                        <button type="button" className="pipeline-card-open" onClick={() => setSelectedId(deal.id)}>
                          <span className="pipeline-card-title">{deal.title}</span>
                          {deal.value !== null && (
                            <span className="pipeline-card-value">{formatMoney(deal.value, deal.currency)}</span>
                          )}
                          <span className="pipeline-card-meta">
                            {deal.assigneeName ? (
                              <span className="pipeline-card-assignee">
                                <User size={12} />
                                {deal.assigneeName}
                              </span>
                            ) : (
                              <span className="pipeline-card-assignee pipeline-card-unassigned">
                                {t('pipeline.unassigned')}
                              </span>
                            )}
                            {deal.expectedCloseAt && (
                              <span className="pipeline-card-date">
                                <CalendarClock size={12} />
                                {formatDate(deal.expectedCloseAt)}
                              </span>
                            )}
                          </span>
                        </button>
                      </article>
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={t('pipeline.create.title')}
        footer={
          <>
            <button type="button" onClick={() => setCreating(false)}>
              {t('pipeline.cancel')}
            </button>
            <button
              type="button"
              className="pipeline-primary"
              onClick={submitCreate}
              disabled={!createForm.title.trim() || createDeal.isPending}
            >
              {t('pipeline.create.submit')}
            </button>
          </>
        }
      >
        <div className="pipeline-form">
          <label>
            {t('pipeline.deal.title')}
            <input
              value={createForm.title}
              onChange={event => setCreateForm({ ...createForm, title: event.target.value })}
              placeholder={t('pipeline.create.titlePlaceholder')}
              maxLength={200}
              autoFocus
            />
          </label>
          <div className="pipeline-form-row">
            <label>
              {t('pipeline.deal.value')}
              <input
                type="number"
                min={0}
                step={1}
                value={createForm.value}
                onChange={event => setCreateForm({ ...createForm, value: event.target.value })}
              />
            </label>
            <label>
              {t('pipeline.deal.currency')}
              <input
                value={createForm.currency}
                maxLength={3}
                onChange={event => setCreateForm({ ...createForm, currency: event.target.value })}
              />
            </label>
          </div>
          <div className="pipeline-form-row">
            <label>
              {t('pipeline.deal.stage')}
              <select
                value={createForm.stageId}
                onChange={event => setCreateForm({ ...createForm, stageId: event.target.value })}
              >
                {stages.map(stage => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('pipeline.deal.assignee')}
              <select
                value={createForm.assigneeKeyId}
                onChange={event => setCreateForm({ ...createForm, assigneeKeyId: event.target.value })}
              >
                {renderAssigneeOptions()}
              </select>
            </label>
          </div>
          <label>
            {t('pipeline.deal.expectedClose')}
            <input
              type="date"
              value={createForm.expectedCloseAt}
              onChange={event => setCreateForm({ ...createForm, expectedCloseAt: event.target.value })}
            />
          </label>
          <label>
            {t('pipeline.deal.notes')}
            <textarea
              rows={3}
              maxLength={5000}
              value={createForm.notes}
              onChange={event => setCreateForm({ ...createForm, notes: event.target.value })}
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={Boolean(selectedId)}
        onClose={() => setSelectedId('')}
        title={detail.data?.title ?? t('pipeline.deal.title')}
        className="pipeline-detail-modal"
        footer={
          <>
            {isAdmin && (
              <button type="button" className="pipeline-danger" onClick={removeDeal} disabled={deleteDeal.isPending}>
                <Trash2 size={15} />
                {t('pipeline.deal.delete')}
              </button>
            )}
            <button type="button" onClick={() => setSelectedId('')}>
              {t('pipeline.cancel')}
            </button>
            <button
              type="button"
              className="pipeline-primary"
              onClick={submitDetail}
              disabled={!detailForm.title.trim() || updateDeal.isPending}
            >
              {t('pipeline.deal.save')}
            </button>
          </>
        }
      >
        {detail.isLoading ? (
          <div className="pipeline-state">
            <Loader2 className="animate-spin" size={22} />
          </div>
        ) : detail.isError || !detail.data ? (
          <div className="pipeline-state pipeline-error">
            <AlertCircle size={20} />
            <p>{t('pipeline.error.load')}</p>
          </div>
        ) : (
          <div className="pipeline-detail">
            <div className="pipeline-form">
              <label>
                {t('pipeline.deal.title')}
                <input
                  value={detailForm.title}
                  onChange={event => setDetailForm({ ...detailForm, title: event.target.value })}
                  maxLength={200}
                />
              </label>
              <div className="pipeline-form-row">
                <label>
                  {t('pipeline.deal.value')}
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={detailForm.value}
                    onChange={event => setDetailForm({ ...detailForm, value: event.target.value })}
                  />
                </label>
                <label>
                  {t('pipeline.deal.currency')}
                  <input
                    value={detailForm.currency}
                    maxLength={3}
                    onChange={event => setDetailForm({ ...detailForm, currency: event.target.value })}
                  />
                </label>
              </div>
              <div className="pipeline-form-row">
                <label>
                  {t('pipeline.deal.stage')}
                  <select
                    value={detailForm.stageId}
                    onChange={event => setDetailForm({ ...detailForm, stageId: event.target.value })}
                  >
                    {stages.map(stage => (
                      <option key={stage.id} value={stage.id}>
                        {stage.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('pipeline.deal.assignee')}
                  <select
                    value={detailForm.assigneeKeyId}
                    onChange={event => setDetailForm({ ...detailForm, assigneeKeyId: event.target.value })}
                  >
                    {renderAssigneeOptions()}
                  </select>
                </label>
              </div>
              <label>
                {t('pipeline.deal.expectedClose')}
                <input
                  type="date"
                  value={detailForm.expectedCloseAt}
                  onChange={event => setDetailForm({ ...detailForm, expectedCloseAt: event.target.value })}
                />
              </label>
              <label>
                {t('pipeline.deal.notes')}
                <textarea
                  rows={3}
                  maxLength={5000}
                  value={detailForm.notes}
                  onChange={event => setDetailForm({ ...detailForm, notes: event.target.value })}
                />
              </label>
            </div>

            <section className="pipeline-history">
              <h3>{t('pipeline.deal.activities')}</h3>
              {detail.data.activities.length === 0 ? (
                <p className="pipeline-history-empty">{t('pipeline.deal.noActivities')}</p>
              ) : (
                <ul>
                  {detail.data.activities.map(activity => (
                    <li key={activity.id}>
                      <div className="pipeline-history-head">
                        <strong>{activity.authorName}</strong>
                        <span className="pipeline-history-kind">{t(`pipeline.activityKind.${activity.kind}`)}</span>
                        <time>{new Date(activity.createdAt).toLocaleString()}</time>
                      </div>
                      {activity.kind === 'stage_change' ? (
                        <p>
                          {stageName(activity.fromStageId)} → {stageName(activity.toStageId)}
                        </p>
                      ) : (
                        activity.body && <p>{activity.body}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <div className="pipeline-note-composer">
                <textarea
                  rows={2}
                  maxLength={5000}
                  value={noteDraft}
                  onChange={event => setNoteDraft(event.target.value)}
                  placeholder={t('pipeline.deal.notePlaceholder')}
                />
                <button type="button" onClick={submitNote} disabled={!noteDraft.trim() || addActivity.isPending}>
                  {t('pipeline.deal.addNote')}
                </button>
              </div>
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}
