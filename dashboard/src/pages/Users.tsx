import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, KeyRound, Loader2, Pencil, Plus, Trash2, Users as UsersIcon } from 'lucide-react';
import { authApi, usersApi, type AuthUser } from '../services/api';
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

type Dialog =
  | { type: 'create' }
  | { type: 'edit'; user: AuthUser }
  | { type: 'reset'; user: AuthUser }
  | { type: 'delete'; user: AuthUser }
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
}

const emptyDraft: Draft = {
  email: '',
  name: '',
  role: 'operator',
  password: '',
  confirm: '',
  current: '',
  isActive: true,
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
    setDraft(draftFor(next));
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

  // A 409 means two different things on this page: the address is taken when creating, and the
  // account is the last usable admin when editing or deleting.
  const describeFailure = (err: unknown, fallback: string): string => {
    const status = (err as { status?: number }).status;
    const message = err instanceof Error ? err.message : '';
    if (status === 409) return t(dialog?.type === 'create' ? 'users.emailTaken' : 'users.lastAdmin');
    return message ? `${t(fallback)}: ${message}` : t(fallback);
  };

  const handleCreate = async () => {
    setSaving(true);
    setError('');
    try {
      await usersApi.create({
        email: draft.email.trim(),
        name: draft.name.trim(),
        password: draft.password,
        role: draft.role,
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
                <th scope="col">{t('common.status')}</th>
                <th scope="col">{t('users.lastLogin')}</th>
                <th scope="col" className="users-actions-header">
                  {t('apiKeys.columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(user => (
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
                    <span className={user.isActive ? 'status-badge active' : 'status-badge inactive'}>
                      {t(user.isActive ? 'common.active' : 'common.inactive')}
                    </span>
                  </td>
                  <td className="user-last-login">{formatDate(user.lastLoginAt)}</td>
                  <td>
                    <span className="actions-cell">
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
              ))}
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
                disabled={saving || !draft.email.trim() || !draft.name.trim() || !passwordReady}
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
