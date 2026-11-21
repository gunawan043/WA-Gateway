import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  AlertTriangle,
  KeyRound,
  Loader2,
  Network,
  Pencil,
  Plus,
  Trash2,
  Users as UsersIcon,
} from 'lucide-react';
import { authApi, usersApi, type AuthUser, type Division } from '../services/api';
import { useDivisionsQuery, useSessionsQuery, useUpdateDivisionMutation } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { isSignedInAsUser, readStoredAccount } from '../utils/credential';
import './Users.css';

// Kept in step with the gateway's MIN_PASSWORD_LENGTH: the form refuses a short password before
// sending it, and the server refuses it again.
const MIN_PASSWORD_LENGTH = 12;
const roleNames = ['admin', 'operator', 'viewer'] as const;

type Role = (typeof roleNames)[number];

/**
 * The Fase 1 grant a legacy role maps to. The full eight-role editor belongs to Fase 1c; until then
 * the create form states the role and the scope, and the gateway derives `api_keys.role` from it.
 */
type AssignmentRole = 'system_admin' | 'agent' | 'analyst';

type ScopeType = 'global' | 'session' | 'team' | 'object';

const assignmentRoleFor = (role: Role): AssignmentRole =>
  role === 'admin' ? 'system_admin' : role === 'viewer' ? 'analyst' : 'agent';

const scopeTypes: ScopeType[] = ['global', 'session', 'team', 'object'];

type Dialog =
  | { type: 'create' }
  | { type: 'edit'; user: AuthUser }
  | { type: 'reset'; user: AuthUser }
  | { type: 'delete'; user: AuthUser }
  | { type: 'divisions'; user: AuthUser }
  | { type: 'password' }
  | null;

interface Draft {
  email: string;
  name: string;
  role: Role;
  password: string;
  confirm: string;
  current: string;
  isActive: boolean;
  scopeType: ScopeType;
  scopeId: string;
}

const emptyDraft: Draft = {
  email: '',
  name: '',
  role: 'operator',
  password: '',
  confirm: '',
  current: '',
  isActive: true,
  scopeType: 'session',
  scopeId: '',
};

function draftFor(dialog: Dialog): Draft {
  if (dialog?.type === 'edit') {
    return {
      ...emptyDraft,
      email: dialog.user.email,
      name: dialog.user.name,
      role: dialog.user.role,
      isActive: dialog.user.isActive,
    };
  }
  return emptyDraft;
}

/**
 * Dashboard accounts. Each row is a person who can sign in with an email and a password, and each
 * owns one linked API key (shown as user-managed on the API Keys page) so role checks, the chat fence
 * and the audit trail keep working unchanged. A key still signs a machine in; this page is only for
 * people.
 */
export function Users() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  useDocumentTitle(t('users.title'));

  const [rows, setRows] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // The caller's own row is marked "You"; deleting it is refused by the gateway as well, but the
  // button says why before the request.
  const [me] = useState(() => readStoredAccount());
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Division membership is per session: one account can sit in different divisions in another
  // session, so the page asks which session it is showing before it reads any membership.
  const { data: sessions = [] } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');
  const [divisionFilter, setDivisionFilter] = useState('all');
  const divisionsQuery = useDivisionsQuery(sessionId);
  const divisions = useMemo(() => divisionsQuery.data ?? [], [divisionsQuery.data]);
  const updateDivision = useUpdateDivisionMutation(sessionId);
  const [divisionDraft, setDivisionDraft] = useState<string[]>([]);

  useEffect(() => {
    if (sessionId || sessions.length === 0) return;
    const ready = sessions.find(session => session.status === 'ready') ?? sessions[0];
    setSessionId(ready.id);
  }, [sessionId, sessions]);

  // A division deleted, or a session switched, while its filter is selected must not leave the
  // table mysteriously empty.
  useEffect(() => {
    if (divisionFilter === 'all' || divisionFilter === 'unassigned') return;
    if (!divisionsQuery.isLoading && !divisions.some(division => division.id === divisionFilter)) {
      setDivisionFilter('all');
    }
  }, [divisionFilter, divisions, divisionsQuery.isLoading]);

  const memberships = useMemo(() => {
    const byKey = new Map<string, Division[]>();
    for (const division of divisions) {
      for (const agent of division.agents) {
        const list = byKey.get(agent.apiKeyId);
        if (list) list.push(division);
        else byKey.set(agent.apiKeyId, [division]);
      }
    }
    return byKey;
  }, [divisions]);

  const visibleRows = useMemo(() => {
    if (divisionFilter === 'all') return rows;
    if (divisionFilter === 'unassigned') return rows.filter(user => !memberships.get(user.apiKeyId)?.length);
    return rows.filter(user => memberships.get(user.apiKeyId)?.some(division => division.id === divisionFilter));
  }, [rows, divisionFilter, memberships]);

  const load = useCallback(async () => {
    try {
      setRows(await usersApi.list());
      setLoadError(null);
    } catch (err) {
      setLoadError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (next: Exclude<Dialog, null>) => {
    const base = draftFor(next);
    // A new account defaults to the session the page is already showing, so the scope picker is
    // never left on an empty target.
    setDraft(next.type === 'create' ? { ...base, scopeId: sessionId } : base);
    setError('');
    setDialog(next);
  };

  const close = () => {
    if (saving) return;
    setDialog(null);
    setError('');
  };

  const passwordTooShort = draft.password.length > 0 && draft.password.length < MIN_PASSWORD_LENGTH;
  const passwordMismatch = draft.confirm.length > 0 && draft.confirm !== draft.password;
  const passwordReady = draft.password.length >= MIN_PASSWORD_LENGTH && draft.confirm === draft.password;
  // A global grant has no target; every other scope needs one before the form may be submitted.
  // An untouched session picker shows — and sends — the session the page is already showing, so the
  // displayed value and the request can never disagree.
  const scopeIdValue = draft.scopeId || (draft.scopeType === 'session' ? sessionId : '');
  const scopeReady = draft.scopeType === 'global' || scopeIdValue.trim().length > 0;

  // A 409 means two different things on this page: the address is taken when creating, and the
  // account is the last usable admin when editing or deleting.
  const describeFailure = (err: unknown, fallback: string): string => {
    const status = (err as { status?: number }).status;
    const message = err instanceof Error ? err.message : '';
    // A 409 on this page is a taken address when creating and the last admin otherwise; a division
    // write has its own conflict answers and keeps the server's wording.
    if (status === 409 && dialog?.type !== 'divisions') {
      return t(dialog?.type === 'create' ? 'users.emailTaken' : 'users.lastAdmin');
    }
    return message ? `${t(fallback)}: ${message}` : t(fallback);
  };

  const handleCreate = async () => {
    setSaving(true);
    setError('');
    try {
      // A new account never gets access implicitly: the scope is part of the request, and the
      // gateway refuses an account without it (docs/35 §35.4.1).
      await usersApi.create({
        email: draft.email.trim(),
        name: draft.name.trim(),
        password: draft.password,
        role: draft.role,
        assignments: [
          {
            role: assignmentRoleFor(draft.role),
            scopeType: draft.scopeType,
            scopeId: draft.scopeType === 'global' ? undefined : scopeIdValue.trim(),
          },
        ],
      });
      toast.success(t('users.created'));
      setDialog(null);
      await load();
    } catch (err) {
      setError(describeFailure(err, 'users.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (dialog?.type !== 'edit') return;
    setSaving(true);
    setError('');
    try {
      await usersApi.update(dialog.user.id, {
        name: draft.name.trim(),
        role: draft.role,
        isActive: draft.isActive,
      });
      toast.success(t('users.updated'));
      setDialog(null);
      await load();
    } catch (err) {
      setError(describeFailure(err, 'users.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const openDivisions = (user: AuthUser) => {
    setDivisionDraft(divisions.filter(d => d.agents.some(a => a.apiKeyId === user.apiKeyId)).map(d => d.id));
    setError('');
    setDialog({ type: 'divisions', user });
  };

  const handleSaveDivisions = async () => {
    if (dialog?.type !== 'divisions') return;
    setSaving(true);
    setError('');
    try {
      // Re-read before writing: the endpoint replaces the whole member set, so a stale list would
      // drop a CS another admin added since this page loaded.
      const fresh = (await divisionsQuery.refetch()).data ?? divisions;
      const keyId = dialog.user.apiKeyId;
      const changed = fresh.filter(division => {
        const member = division.agents.some(agent => agent.apiKeyId === keyId);
        return member !== divisionDraft.includes(division.id);
      });
      for (const division of changed) {
        // The set is sent whole; every other member, a machine key included, is carried over.
        const next = division.agents.map(agent => agent.apiKeyId).filter(id => id !== keyId);
        if (divisionDraft.includes(division.id)) next.push(keyId);
        await updateDivision.mutateAsync({ divisionId: division.id, data: { agentKeyIds: next } });
      }
      toast.success(t('users.divisionsSaved'));
      setDialog(null);
    } catch (err) {
      setError(describeFailure(err, 'users.divisionsFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (dialog?.type !== 'reset') return;
    setSaving(true);
    setError('');
    try {
      await usersApi.resetPassword(dialog.user.id, draft.password);
      toast.success(t('users.passwordReset'));
      setDialog(null);
    } catch (err) {
      setError(describeFailure(err, 'users.resetFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (dialog?.type !== 'delete') return;
    setSaving(true);
    setError('');
    try {
      await usersApi.remove(dialog.user.id);
      toast.success(t('users.deleted'));
      setDialog(null);
      await load();
    } catch (err) {
      setError(describeFailure(err, 'users.deleteFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    setSaving(true);
    setError('');
    try {
      await authApi.changePassword(draft.current, draft.password);
      toast.success(t('users.passwordChanged'));
      setDialog(null);
    } catch (err) {
      const status = (err as { status?: number }).status;
      // The gateway answers 401 for a wrong current password; the new one is never echoed back.
      setError(
        status === 401
          ? err instanceof Error
            ? err.message
            : t('users.changeFailed')
          : describeFailure(err, 'users.changeFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (value: string | null): string =>
    value ? new Date(value).toLocaleString(i18n.resolvedLanguage) : t('common.never');

  const passwordFields = (label: string) => (
    <>
      <label htmlFor="user-password">{label}</label>
      <input
        id="user-password"
        type="password"
        autoComplete="new-password"
        value={draft.password}
        placeholder={t('users.passwordPlaceholder')}
        onChange={e => setDraft(prev => ({ ...prev, password: e.target.value }))}
        aria-describedby={passwordTooShort ? 'user-password-hint' : undefined}
      />
      <span id="user-password-hint" className={passwordTooShort ? 'user-field-hint error' : 'user-field-hint'}>
        {t('users.passwordHint')}
      </span>
      <label htmlFor="user-confirm">{t('users.confirmPassword')}</label>
      <input
        id="user-confirm"
        type="password"
        autoComplete="new-password"
        value={draft.confirm}
        onChange={e => setDraft(prev => ({ ...prev, confirm: e.target.value }))}
        aria-describedby={passwordMismatch ? 'user-confirm-error' : undefined}
      />
      {passwordMismatch && (
        <span id="user-confirm-error" className="user-field-hint error" role="alert">
          {t('users.passwordMismatch')}
        </span>
      )}
    </>
  );

  const errorNote = error ? (
    <p className="user-dialog-error" role="alert">
      <AlertTriangle size={16} />
      {error}
    </p>
  ) : null;

  return (
    <div className="users-page">
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <>
            {isSignedInAsUser() && (
              <button className="btn-secondary" onClick={() => open({ type: 'password' })}>
                <KeyRound size={18} />
                {t('users.changePassword')}
              </button>
            )}
            <button className="btn-primary" onClick={() => open({ type: 'create' })}>
              <Plus size={18} />
              {t('users.createBtn')}
            </button>
          </>
        }
      />

      <div className="users-toolbar">
        <label className="users-toolbar-field" htmlFor="users-session">
          {t('users.session')}
          <select
            id="users-session"
            value={sessionId}
            onChange={event => {
              setSessionId(event.target.value);
              setDivisionFilter('all');
            }}
            disabled={sessions.length === 0}
          >
            {sessions.length === 0 && <option value="">{t('users.noSessions')}</option>}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name || session.id}
              </option>
            ))}
          </select>
        </label>
        <label className="users-toolbar-field" htmlFor="users-division-filter">
          {t('users.divisionFilter')}
          <select
            id="users-division-filter"
            value={divisionFilter}
            onChange={event => setDivisionFilter(event.target.value)}
            disabled={!sessionId || divisions.length === 0}
          >
            <option value="all">{t('users.allDivisions')}</option>
            <option value="unassigned">{t('users.noDivision')}</option>
            {divisions.map(division => (
              <option key={division.id} value={division.id}>
                {division.name}
              </option>
            ))}
          </select>
        </label>
        {divisionsQuery.error && (
          <span className="users-toolbar-error" role="alert">
            {t('users.divisionsLoadError')}
          </span>
        )}
      </div>

      {loading ? (
        <div className="users-empty" role="status">
          <Loader2 className="animate-spin" size={32} />
        </div>
      ) : loadError ? (
        <div className="users-empty" role="alert">
          <AlertCircle size={48} strokeWidth={1} />
          <h3>{t('users.loadError')}</h3>
          <p>{loadError.message}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="users-empty">
          <UsersIcon size={48} strokeWidth={1} />
          <h3>{t('users.empty')}</h3>
          <p>{t('users.emptyHint')}</p>
        </div>
      ) : (
        <div className="users-table-container">
          <table className="users-table">
            <thead>
              <tr>
                <th scope="col">{t('common.name')}</th>
                <th scope="col">{t('common.role')}</th>
                <th scope="col">{t('users.divisions')}</th>
                <th scope="col">{t('common.status')}</th>
                <th scope="col">{t('users.lastLogin')}</th>
                <th scope="col" className="users-actions-header">
                  {t('apiKeys.columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(user => {
                const memberOf = memberships.get(user.apiKeyId) ?? [];
                return (
                  <tr key={user.id}>
                    <td>
                      <span className="user-name">
                        {user.name}
                        {me?.id === user.id && <span className="user-you-badge">{t('users.you')}</span>}
                      </span>
                      <span className="user-email">{user.email}</span>
                    </td>
                    <td>
                      <code className="user-role">{t(`apiKeys.roles.${user.role}`)}</code>
                    </td>
                    <td>
                      <span className="user-divisions">
                        {memberOf.length === 0 ? (
                          <span className="user-division-none">{t('users.noDivision')}</span>
                        ) : (
                          memberOf.map(division => (
                            <span key={division.id} className="user-division-chip">
                              {division.name}
                            </span>
                          ))
                        )}
                      </span>
                    </td>
                    <td>
                      <span className={user.isActive ? 'status-badge active' : 'status-badge inactive'}>
                        {t(user.isActive ? 'common.active' : 'common.inactive')}
                      </span>
                    </td>
                    <td className="user-last-login">{formatDate(user.lastLoginAt)}</td>
                    <td>
                      <span className="actions-cell">
                        <button
                          className="icon-btn"
                          title={t('users.manageDivisions')}
                          aria-label={t('users.manageDivisions')}
                          onClick={() => openDivisions(user)}
                          disabled={!sessionId || divisions.length === 0}
                        >
                          <Network size={16} />
                        </button>
                        <button
                          className="icon-btn"
                          title={t('users.editTitle')}
                          aria-label={t('users.editTitle')}
                          onClick={() => open({ type: 'edit', user })}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-btn"
                          title={t('users.resetTitle')}
                          aria-label={t('users.resetTitle')}
                          onClick={() => open({ type: 'reset', user })}
                        >
                          <KeyRound size={16} />
                        </button>
                        <button
                          className="icon-btn danger"
                          title={t('common.delete')}
                          aria-label={t('users.deleteTitle')}
                          onClick={() => open({ type: 'delete', user })}
                        >
                          <Trash2 size={16} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="users-filter-empty">
                    {t('users.filteredEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="users-note">{t('users.keyManaged')}</p>

      {dialog?.type === 'create' && (
        <Modal
          open
          onClose={close}
          title={t('users.modalTitle')}
          closeLabel={t('common.close')}
          initialFocusRef={firstFieldRef}
          footer={
            <>
              <button className="btn-secondary" onClick={close} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void handleCreate()}
                disabled={saving || !draft.email.trim() || !draft.name.trim() || !passwordReady || !scopeReady}
              >
                {saving ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
              </button>
            </>
          }
        >
          <label htmlFor="user-email">{t('users.email')}</label>
          <input
            id="user-email"
            ref={firstFieldRef}
            type="email"
            autoComplete="off"
            value={draft.email}
            placeholder={t('users.emailPlaceholder')}
            onChange={e => setDraft(prev => ({ ...prev, email: e.target.value }))}
          />
          <label htmlFor="user-name">{t('common.name')}</label>
          <input
            id="user-name"
            type="text"
            autoComplete="off"
            value={draft.name}
            placeholder={t('users.namePlaceholder')}
            onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
          />
          <label htmlFor="user-role">{t('common.role')}</label>
          <select
            id="user-role"
            value={draft.role}
            onChange={e => setDraft(prev => ({ ...prev, role: e.target.value as Role }))}
          >
            {roleNames.map(role => (
              <option key={role} value={role}>
                {t(`apiKeys.roles.${role}`)}
              </option>
            ))}
          </select>
          <label htmlFor="user-scope">{t('users.scope')}</label>
          <select
            id="user-scope"
            value={draft.scopeType}
            onChange={e => {
              const scopeType = e.target.value as ScopeType;
              setDraft(prev => ({
                ...prev,
                scopeType,
                scopeId: scopeType === 'session' ? sessionId : '',
              }));
            }}
          >
            {scopeTypes.map(scope => (
              <option key={scope} value={scope}>
                {t(`users.scope_${scope}`)}
              </option>
            ))}
          </select>
          {draft.scopeType !== 'global' && (
            <>
              <label htmlFor="user-scope-target">{t('users.scopeTarget')}</label>
              {draft.scopeType === 'session' ? (
                <select
                  id="user-scope-target"
                  value={scopeIdValue}
                  onChange={e => setDraft(prev => ({ ...prev, scopeId: e.target.value }))}
                >
                  {sessions.length === 0 && <option value="">{t('users.noSessions')}</option>}
                  {sessions.map(session => (
                    <option key={session.id} value={session.id}>
                      {session.name || session.id}
                    </option>
                  ))}
                </select>
              ) : draft.scopeType === 'team' ? (
                <select
                  id="user-scope-target"
                  value={scopeIdValue}
                  onChange={e => setDraft(prev => ({ ...prev, scopeId: e.target.value }))}
                >
                  <option value="">{t('users.scopeTargetPlaceholder')}</option>
                  {divisions.map(division => (
                    <option key={division.id} value={division.id}>
                      {division.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="user-scope-target"
                  type="text"
                  autoComplete="off"
                  value={draft.scopeId}
                  placeholder={t('users.scopeTargetPlaceholder')}
                  onChange={e => setDraft(prev => ({ ...prev, scopeId: e.target.value }))}
                />
              )}
              <span className="user-field-hint">{t('users.scopeHint')}</span>
            </>
          )}
          {passwordFields(t('common.password'))}
          {errorNote}
        </Modal>
      )}

      {dialog?.type === 'edit' && (
        <Modal
          open
          onClose={close}
          title={t('users.editTitle')}
          closeLabel={t('common.close')}
          initialFocusRef={firstFieldRef}
          footer={
            <>
              <button className="btn-secondary" onClick={close} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void handleUpdate()}
                disabled={saving || !draft.name.trim()}
              >
                {saving ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
              </button>
            </>
          }
        >
          {/* The address identifies the account and its linked key; changing it would be a new
              account, so it is shown and not edited. */}
          <label htmlFor="user-email-readonly">{t('users.email')}</label>
          <input id="user-email-readonly" type="email" value={dialog.user.email} readOnly disabled />
          <label htmlFor="user-name">{t('common.name')}</label>
          <input
            id="user-name"
            ref={firstFieldRef}
            type="text"
            autoComplete="off"
            value={draft.name}
            placeholder={t('users.namePlaceholder')}
            onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
          />
          <label htmlFor="user-role">{t('common.role')}</label>
          <select
            id="user-role"
            value={draft.role}
            onChange={e => setDraft(prev => ({ ...prev, role: e.target.value as Role }))}
          >
            {roleNames.map(role => (
              <option key={role} value={role}>
                {t(`apiKeys.roles.${role}`)}
              </option>
            ))}
          </select>
          <label className="user-checkbox" htmlFor="user-active">
            <input
              id="user-active"
              type="checkbox"
              checked={draft.isActive}
              onChange={e => setDraft(prev => ({ ...prev, isActive: e.target.checked }))}
            />
            {t('common.active')}
          </label>
          {!draft.isActive && <span className="user-field-hint">{t('users.deactivateHint')}</span>}
          {errorNote}
        </Modal>
      )}

      {dialog?.type === 'divisions' && (
        <Modal
          open
          onClose={close}
          title={t('users.manageDivisions')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={close} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void handleSaveDivisions()}
                disabled={saving || !sessionId || divisions.length === 0}
              >
                {saving ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
              </button>
            </>
          }
        >
          <p className="user-dialog-note">
            {dialog.user.name} · {dialog.user.email}
          </p>
          <p className="user-dialog-note">{t('users.divisionsHint')}</p>
          {divisions.length === 0 ? (
            <p className="user-dialog-note">{t('users.noDivisions')}</p>
          ) : (
            <fieldset className="user-divisions-field">
              <legend className="users-divisions-legend">{t('users.divisions')}</legend>
              {divisions.map(division => (
                <label key={division.id} className="user-checkbox" htmlFor={`user-division-${division.id}`}>
                  <input
                    id={`user-division-${division.id}`}
                    type="checkbox"
                    checked={divisionDraft.includes(division.id)}
                    onChange={event =>
                      setDivisionDraft(prev =>
                        event.target.checked ? [...prev, division.id] : prev.filter(id => id !== division.id),
                      )
                    }
                  />
                  {division.name}
                  {!division.isActive && <span className="status-badge inactive">{t('common.inactive')}</span>}
                </label>
              ))}
            </fieldset>
          )}
          {errorNote}
        </Modal>
      )}

      {dialog?.type === 'reset' && (
        <Modal
          open
          onClose={close}
          title={t('users.resetTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={close} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleReset()} disabled={saving || !passwordReady}>
                {saving ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
              </button>
            </>
          }
        >
          <p className="user-dialog-note">{dialog.user.email}</p>
          {passwordFields(t('users.newPassword'))}
          <p className="user-dialog-note">{t('users.resetHint')}</p>
          {errorNote}
        </Modal>
      )}

      {dialog?.type === 'password' && (
        <Modal
          open
          onClose={close}
          title={t('users.changeTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={close} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void handleChangePassword()}
                disabled={saving || !draft.current || !passwordReady}
              >
                {saving ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
              </button>
            </>
          }
        >
          <label htmlFor="current-password">{t('users.currentPassword')}</label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={draft.current}
            onChange={e => setDraft(prev => ({ ...prev, current: e.target.value }))}
          />
          {passwordFields(t('users.newPassword'))}
          {errorNote}
        </Modal>
      )}

      {dialog?.type === 'delete' && (
        <Modal
          open
          onClose={close}
          title={t('users.deleteTitle')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={close} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-danger"
                onClick={() => void handleDelete()}
                disabled={saving || me?.id === dialog.user.id}
              >
                {saving ? <Loader2 className="animate-spin" size={16} /> : t('common.delete')}
              </button>
            </>
          }
        >
          <div className="confirm-icon-wrapper">
            <AlertTriangle size={48} className="confirm-warning-icon" />
          </div>
          <p className="confirm-message">{t('users.deleteConfirm', { email: dialog.user.email })}</p>
          {me?.id === dialog.user.id && (
            <p className="key-signed-in-warning" role="note">
              <AlertTriangle size={16} />
              {t('users.selfDelete')}
            </p>
          )}
          {errorNote}
        </Modal>
      )}
    </div>
  );
}
