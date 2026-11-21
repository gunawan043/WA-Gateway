import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import {
  useAgentsQuery,
  useCreateDivisionMutation,
  useDeleteDivisionMutation,
  useDivisionSettingsQuery,
  useDivisionsQuery,
  useSessionsQuery,
  useUpdateDivisionMutation,
  useUpdateDivisionSettingsMutation,
} from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import type { Division } from '../services/api';
import './Divisions.css';

interface Draft {
  name: string;
  keywords: string;
  menuLabel: string;
  welcomeText: string;
  sortOrder: string;
  slaMinutes: string;
  isActive: boolean;
  agentKeyIds: string[];
}

interface SettingsDraft {
  enabled: boolean;
  menuHeader: string;
  invalidReply: string;
  idleHours: string;
}

type Dialog = { type: 'create' } | { type: 'edit'; division: Division } | { type: 'delete'; division: Division };

const emptyDraft = (): Draft => ({
  name: '',
  keywords: '',
  menuLabel: '',
  welcomeText: '',
  sortOrder: '0',
  slaMinutes: '0',
  isActive: true,
  agentKeyIds: [],
});

const draftOf = (division: Division): Draft => ({
  name: division.name,
  keywords: division.keywords.join(', '),
  menuLabel: division.menuLabel ?? '',
  welcomeText: division.welcomeText ?? '',
  sortOrder: String(division.sortOrder),
  slaMinutes: String(division.slaMinutes),
  isActive: division.isActive,
  agentKeyIds: division.agents.map(agent => agent.apiKeyId),
});

const keywordsOf = (value: string): string[] =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

/**
 * Division routing: the numbered menu a customer sees on the shared number, and which CS answers.
 *
 * Configuration only — the routing itself happens on the inbound message path and lands in the
 * Inbox page, which is where a conversation is read and answered.
 */
export function Divisions() {
  const { t } = useTranslation();
  const toast = useToast();
  useDocumentTitle(t('divisions.title'));

  const { data: sessions = [], isLoading: sessionsLoading } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');

  useEffect(() => {
    if (sessionId || sessions.length === 0) return;
    const ready = sessions.find(session => session.status === 'ready') ?? sessions[0];
    setSessionId(ready.id);
  }, [sessionId, sessions]);

  const divisions = useDivisionsQuery(sessionId);
  const settings = useDivisionSettingsQuery(sessionId);
  const { data: agents = [] } = useAgentsQuery();
  const createDivision = useCreateDivisionMutation(sessionId);
  const updateDivision = useUpdateDivisionMutation(sessionId);
  const deleteDivision = useDeleteDivisionMutation(sessionId);
  const updateSettings = useUpdateDivisionSettingsMutation(sessionId);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>({
    enabled: true,
    menuHeader: '',
    invalidReply: '',
    idleHours: '24',
  });

  useEffect(() => {
    if (!settings.data) return;
    setSettingsDraft({
      enabled: settings.data.enabled,
      menuHeader: settings.data.menuHeader ?? '',
      invalidReply: settings.data.invalidReply ?? '',
      idleHours: String(settings.data.idleHours),
    });
  }, [settings.data]);

  const rows = divisions.data ?? [];

  const openCreate = () => {
    setDraft(emptyDraft());
    setDialog({ type: 'create' });
  };

  const openEdit = (division: Division) => {
    setDraft(draftOf(division));
    setDialog({ type: 'edit', division });
  };

  const close = () => setDialog(null);

  const saving = createDivision.isPending || updateDivision.isPending;

  const submit = () => {
    const payload = {
      name: draft.name.trim(),
      keywords: keywordsOf(draft.keywords),
      menuLabel: draft.menuLabel.trim() || null,
      welcomeText: draft.welcomeText.trim() || null,
      sortOrder: Number.parseInt(draft.sortOrder, 10) || 0,
      slaMinutes: Number.parseInt(draft.slaMinutes, 10) || 0,
      isActive: draft.isActive,
      agentKeyIds: draft.agentKeyIds,
    };
    if (!payload.name) return;

    if (dialog?.type === 'edit') {
      updateDivision.mutate(
        { divisionId: dialog.division.id, data: payload },
        {
          onSuccess: () => {
            toast.success(t('divisions.updated'));
            close();
          },
          onError: error => toast.error(error instanceof Error ? error.message : t('divisions.saveFailed')),
        },
      );
      return;
    }

    createDivision.mutate(payload, {
      onSuccess: () => {
        toast.success(t('divisions.created'));
        close();
      },
      onError: error => toast.error(error instanceof Error ? error.message : t('divisions.saveFailed')),
    });
  };

  const confirmDelete = (division: Division) => {
    deleteDivision.mutate(division.id, {
      onSuccess: () => {
        toast.success(t('divisions.deleted'));
        close();
      },
      onError: error => toast.error(error instanceof Error ? error.message : t('divisions.deleteFailed')),
    });
  };

  const saveSettings = () => {
    updateSettings.mutate(
      {
        enabled: settingsDraft.enabled,
        menuHeader: settingsDraft.menuHeader.trim() || null,
        invalidReply: settingsDraft.invalidReply.trim() || null,
        idleHours: Number.parseInt(settingsDraft.idleHours, 10) || 0,
      },
      {
        onSuccess: () => toast.success(t('divisions.settings.saved')),
        onError: error => toast.error(error instanceof Error ? error.message : t('divisions.settings.saveFailed')),
      },
    );
  };

  const toggleAgent = (apiKeyId: string) => {
    setDraft(prev => ({
      ...prev,
      agentKeyIds: prev.agentKeyIds.includes(apiKeyId)
        ? prev.agentKeyIds.filter(id => id !== apiKeyId)
        : [...prev.agentKeyIds, apiKeyId],
    }));
  };

  return (
    <div className="divisions-page">
      <PageHeader
        title={t('divisions.title')}
        subtitle={t('divisions.subtitle')}
        actions={
          <select
            className="divisions-session-select"
            value={sessionId}
            onChange={event => setSessionId(event.target.value)}
            aria-label={t('divisions.session')}
            disabled={sessionsLoading}
          >
            {sessions.length === 0 && <option value="">{t('divisions.noSessions')}</option>}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        }
      />

      {!sessionId && !sessionsLoading ? (
        <div className="divisions-empty">
          <Users size={32} />
          <p>{t('divisions.empty.selectSession')}</p>
        </div>
      ) : (
        <>
          <section className="divisions-list" aria-label={t('divisions.title')}>
            <div className="divisions-list-head">
              <h2>{t('divisions.menuTitle')}</h2>
              <button type="button" className="btn-primary" onClick={openCreate}>
                <Plus size={16} />
                {t('divisions.create')}
              </button>
            </div>

            {divisions.isLoading ? (
              <div className="divisions-empty">
                <Loader2 className="animate-spin" size={24} />
              </div>
            ) : divisions.isError ? (
              <div className="divisions-empty divisions-error">
                <AlertCircle size={22} />
                <p>{t('divisions.loadError')}</p>
              </div>
            ) : rows.length === 0 ? (
              <div className="divisions-empty">
                <Users size={28} />
                <p>{t('divisions.empty.list')}</p>
              </div>
            ) : (
              <ol className="divisions-items">
                {rows.map((division, index) => (
                  <li key={division.id} className={division.isActive ? '' : 'is-inactive'}>
                    <span className="divisions-index">{index + 1}</span>
                    <div className="divisions-body">
                      <div className="divisions-name-row">
                        <strong>{division.name}</strong>
                        {!division.isActive && <span className="divisions-badge">{t('divisions.inactive')}</span>}
                      </div>
                      <p className="divisions-menu-label">{division.menuLabel ?? division.name}</p>
                      {division.keywords.length > 0 && (
                        <ul className="divisions-keywords">
                          {division.keywords.map(keyword => (
                            <li key={keyword}>{keyword}</li>
                          ))}
                        </ul>
                      )}
                      <p className="divisions-agents">
                        {division.agents.length === 0
                          ? t('divisions.noAgents')
                          : division.agents.map(agent => agent.name).join(', ')}
                      </p>
                    </div>
                    <div className="divisions-actions">
                      <button type="button" onClick={() => openEdit(division)} aria-label={t('divisions.edit')}>
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialog({ type: 'delete', division })}
                        aria-label={t('divisions.delete')}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="divisions-settings" aria-label={t('divisions.settings.title')}>
            <h2>{t('divisions.settings.title')}</h2>
            <p className="divisions-hint">{t('divisions.settings.hint')}</p>

            <label className="divisions-check">
              <input
                type="checkbox"
                checked={settingsDraft.enabled}
                onChange={event => setSettingsDraft(prev => ({ ...prev, enabled: event.target.checked }))}
              />
              {t('divisions.settings.enabled')}
            </label>

            <label htmlFor="division-menu-header">{t('divisions.settings.menuHeader')}</label>
            <textarea
              id="division-menu-header"
              rows={2}
              value={settingsDraft.menuHeader}
              placeholder={t('divisions.settings.menuHeaderPlaceholder')}
              onChange={event => setSettingsDraft(prev => ({ ...prev, menuHeader: event.target.value }))}
            />

            <label htmlFor="division-invalid-reply">{t('divisions.settings.invalidReply')}</label>
            <textarea
              id="division-invalid-reply"
              rows={2}
              value={settingsDraft.invalidReply}
              placeholder={t('divisions.settings.invalidReplyPlaceholder')}
              onChange={event => setSettingsDraft(prev => ({ ...prev, invalidReply: event.target.value }))}
            />

            <label htmlFor="division-idle-hours">{t('divisions.settings.idleHours')}</label>
            <input
              id="division-idle-hours"
              type="number"
              min={0}
              max={720}
              value={settingsDraft.idleHours}
              onChange={event => setSettingsDraft(prev => ({ ...prev, idleHours: event.target.value }))}
            />
            <p className="divisions-hint">{t('divisions.settings.idleHoursHint')}</p>

            <button type="button" className="btn-primary" onClick={saveSettings} disabled={updateSettings.isPending}>
              {updateSettings.isPending ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
            </button>
          </section>
        </>
      )}

      {(dialog?.type === 'create' || dialog?.type === 'edit') && (
        <Modal
          open
          onClose={close}
          title={dialog.type === 'edit' ? t('divisions.editTitle') : t('divisions.createTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={close} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={submit} disabled={saving || !draft.name.trim()}>
                {saving ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
              </button>
            </>
          }
        >
          <label htmlFor="division-name">{t('divisions.name')}</label>
          <input
            id="division-name"
            value={draft.name}
            placeholder={t('divisions.namePlaceholder')}
            onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))}
          />

          <label htmlFor="division-menu-label">{t('divisions.menuLabel')}</label>
          <input
            id="division-menu-label"
            value={draft.menuLabel}
            placeholder={t('divisions.menuLabelPlaceholder')}
            onChange={event => setDraft(prev => ({ ...prev, menuLabel: event.target.value }))}
          />

          <label htmlFor="division-keywords">{t('divisions.keywords')}</label>
          <input
            id="division-keywords"
            value={draft.keywords}
            placeholder={t('divisions.keywordsPlaceholder')}
            onChange={event => setDraft(prev => ({ ...prev, keywords: event.target.value }))}
          />
          <p className="divisions-hint">{t('divisions.keywordsHint')}</p>

          <label htmlFor="division-welcome">{t('divisions.welcomeText')}</label>
          <textarea
            id="division-welcome"
            rows={2}
            value={draft.welcomeText}
            placeholder={t('divisions.welcomeTextPlaceholder')}
            onChange={event => setDraft(prev => ({ ...prev, welcomeText: event.target.value }))}
          />

          <div className="divisions-row">
            <div>
              <label htmlFor="division-sort">{t('divisions.sortOrder')}</label>
              <input
                id="division-sort"
                type="number"
                min={0}
                max={1000}
                value={draft.sortOrder}
                onChange={event => setDraft(prev => ({ ...prev, sortOrder: event.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="division-sla">{t('divisions.slaMinutes')}</label>
              <input
                id="division-sla"
                type="number"
                min={0}
                max={10080}
                value={draft.slaMinutes}
                onChange={event => setDraft(prev => ({ ...prev, slaMinutes: event.target.value }))}
              />
            </div>
          </div>
          <p className="divisions-hint">{t('divisions.slaMinutesHint')}</p>

          <label className="divisions-check">
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={event => setDraft(prev => ({ ...prev, isActive: event.target.checked }))}
            />
            {t('divisions.isActive')}
          </label>

          <fieldset className="divisions-agents-field">
            <legend>{t('divisions.agents')}</legend>
            <p className="divisions-hint">{t('divisions.agentsHint')}</p>
            {agents.length === 0 ? (
              <p className="divisions-hint">{t('divisions.noAgentsAvailable')}</p>
            ) : (
              <ul>
                {agents.map(agent => (
                  <li key={agent.id}>
                    <label className="divisions-check">
                      <input
                        type="checkbox"
                        checked={draft.agentKeyIds.includes(agent.id)}
                        onChange={() => toggleAgent(agent.id)}
                      />
                      {agent.name}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        </Modal>
      )}

      {dialog?.type === 'delete' && (
        <Modal
          open
          onClose={close}
          title={t('divisions.deleteTitle')}
          closeLabel={t('common.close')}
          className="confirm-modal"
          footer={
            <>
              <button className="btn-secondary" onClick={close} disabled={deleteDivision.isPending}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-danger"
                onClick={() => confirmDelete(dialog.division)}
                disabled={deleteDivision.isPending}
              >
                {deleteDivision.isPending ? <Loader2 className="animate-spin" size={16} /> : t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('divisions.deleteConfirm', { name: dialog.division.name })}</p>
        </Modal>
      )}

      <p className="divisions-note">{t('divisions.note')}</p>
    </div>
  );
}
