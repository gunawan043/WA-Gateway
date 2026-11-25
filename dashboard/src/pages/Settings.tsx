import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, Loader2, RefreshCw, Save } from 'lucide-react';
import {
  alimCoreSettingsApi,
  type AlimCoreField,
  type AlimCoreSettings,
  type AlimCoreSaveResult,
} from '../services/api';
import { PageHeader } from '../components/PageHeader';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import './Settings.css';

const SECTION_ORDER: AlimCoreField['section'][] = ['core', 'sso', 'approval', 'ingest', 'retry'];

/**
 * The ALIM Core connection in one page.
 *
 * Two things shape the design. A secret is never sent to the browser, so its input starts empty and
 * says whether one is stored — an untouched secret is preserved rather than cleared. And a save only
 * reaches the running process at restart, so the page never claims a value is live: it shows which
 * fields are waiting and offers the restart as a separate, deliberate action.
 */
export function Settings() {
  const { t } = useTranslation();
  useDocumentTitle(t('settings.title'));

  const [settings, setSettings] = useState<AlimCoreSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await alimCoreSettingsApi.get();
      setSettings(data);
      setDraft({});
      setTouched(new Set());
      setErrors({});
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('settings.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const grouped = useMemo(() => {
    if (!settings) return [];
    return SECTION_ORDER.map(section => ({
      section,
      fields: settings.fields.filter(field => field.section === section),
    })).filter(group => group.fields.length > 0);
  }, [settings]);

  function fieldValue(field: AlimCoreField): string {
    if (field.kind === 'secret') return draft[field.key] ?? '';
    return draft[field.key] ?? field.value;
  }

  function change(field: AlimCoreField, value: string) {
    setDraft(previous => ({ ...previous, [field.key]: value }));
    setTouched(previous => new Set(previous).add(field.key));
    setErrors(previous => {
      if (!(field.key in previous)) return previous;
      const next = { ...previous };
      delete next[field.key];
      return next;
    });
  }

  async function save() {
    const values: Record<string, string> = {};
    for (const key of touched) {
      // An untouched secret is not submitted at all: sending "" means "unchanged" to the server, but
      // omitting the key says the same thing without relying on that convention.
      values[key] = draft[key] ?? '';
    }
    if (Object.keys(values).length === 0) {
      setMessage(t('settings.none'));
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const result: AlimCoreSaveResult = await alimCoreSettingsApi.save(values);
      if (!result.saved) {
        setErrors(result.errors ?? {});
        setMessage(result.message ?? t('settings.saveFailed'));
        return;
      }
      setMessage(t('settings.saved'));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function restart() {
    setRestarting(true);
    try {
      await alimCoreSettingsApi.restart();
      setMessage(t('settings.restartSent'));
    } catch {
      setMessage(t('settings.restartUnknown'));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <div className="settings-page">
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        actions={
          <div className="settings-actions">
            <button
              type="button"
              className="settings-button settings-button--ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {t('settings.reload')}
            </button>
            <button type="button" className="settings-button" onClick={() => void save()} disabled={saving || loading}>
              {saving ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              {t('settings.save')}
            </button>
          </div>
        }
      />

      {loading && (
        <div className="settings-banner">
          <Loader2 size={16} className="spin" aria-hidden="true" />
          <span>{t('settings.loading')}</span>
        </div>
      )}

      {message && (
        <div className="settings-banner" role="status">
          <CheckCircle size={16} aria-hidden="true" />
          <span>{message}</span>
        </div>
      )}

      {settings?.restartRequired && (
        <div className="settings-banner settings-banner--warn" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{t('settings.pendingTitle')}</span>
          <div className="settings-banner__actions">
            <button type="button" className="settings-button" onClick={() => void restart()} disabled={restarting}>
              {restarting ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <RefreshCw size={16} aria-hidden="true" />
              )}
              {t('settings.applyRestart')}
            </button>
          </div>
        </div>
      )}

      {settings && (
        <div className="settings-card">
          <div className="settings-card__head">
            <h2>{t('settings.statusTitle')}</h2>
          </div>
          <div className="settings-card__body">
            <div className="settings-summary">
              <span className="settings-summary__item">
                <span className={`settings-chip ${settings.ready.sso ? 'settings-chip--set' : ''}`}>
                  {settings.ready.sso ? <CheckCircle size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
                  {settings.ready.sso ? t('settings.ssoReady') : t('settings.ssoNotReady')}
                </span>
                {t('settings.ssoHint')}
              </span>
              <span className="settings-summary__item">
                <span className={`settings-chip ${settings.ready.approval ? 'settings-chip--set' : ''}`}>
                  {settings.ready.approval ? (
                    <CheckCircle size={12} aria-hidden="true" />
                  ) : (
                    <AlertTriangle size={12} aria-hidden="true" />
                  )}
                  {settings.ready.approval ? t('settings.approvalReady') : t('settings.approvalNotReady')}
                </span>
                {t('settings.approvalHint')}
              </span>
            </div>
          </div>
        </div>
      )}

      {grouped.map(group => (
        <section className="settings-card" key={group.section}>
          <div className="settings-card__head">
            <h2>{t(`settings.sections.${group.section}.title`)}</h2>
          </div>
          <div className="settings-card__body">
            <p className="settings-field__help">{t(`settings.sections.${group.section}.hint`)}</p>
            {group.fields.map(field => (
              <div className="settings-field" key={field.key}>
                <label className="settings-field__label" htmlFor={`field-${field.key}`}>
                  {field.label}
                  <span className="settings-field__code">{field.key}</span>
                </label>

                {field.kind === 'enum' ? (
                  <select id={`field-${field.key}`} value={fieldValue(field)} onChange={event => change(field, event.target.value)}>
                    {field.choices?.map(choice => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`field-${field.key}`}
                    type={field.kind === 'secret' ? 'password' : field.kind === 'integer' ? 'number' : 'text'}
                    inputMode={field.kind === 'integer' ? 'numeric' : undefined}
                    autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
                    spellCheck={false}
                    value={fieldValue(field)}
                    placeholder={
                      field.kind === 'secret'
                        ? field.isSet
                          ? t('settings.secretKeep')
                          : t('settings.secretEmpty')
                        : field.defaultValue && field.source === 'default'
                          ? field.defaultValue
                          : undefined
                    }
                    onChange={event => change(field, event.target.value)}
                  />
                )}

                <span className="settings-field__meta">
                  {field.kind === 'secret' && (
                    <span className={`settings-chip ${field.isSet ? 'settings-chip--set' : ''}`}>
                      {field.isSet ? t('settings.secretSet') : t('settings.secretUnset')}
                    </span>
                  )}
                  {field.source === 'environment' && <span className="settings-chip">{t('settings.fromEnv')}</span>}
                  {field.pendingRestart && <span className="settings-chip settings-chip--pending">{t('settings.pendingRestart')}</span>}
                  {field.optional && <span className="settings-chip">{t('settings.optional')}</span>}
                </span>

                <span className="settings-field__help">{field.help}</span>
                {errors[field.key] && (
                  <span className="settings-field__error" role="alert">
                    {errors[field.key]}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
