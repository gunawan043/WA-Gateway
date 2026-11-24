import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { API_BASE_URL, authApi } from '../services/api';
import type { StoredAccount } from '../utils/credential';
import './Login.css';

interface LoginProps {
  onLogin: (
    apiKey: string,
    role?: string,
    engineType?: string,
    scoped?: boolean,
    keyId?: string,
    keyName?: string,
    user?: StoredAccount,
  ) => void;
}

/** People sign in with an email and a password; a machine credential is one click away. */
type Mode = 'account' | 'key';

export function Login({ onLogin }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<Mode>('account');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const switchMode = () => {
    // A refusal from one form says nothing about the other, and leaving it on screen under the
    // fields it no longer describes is worse than showing nothing.
    setError('');
    setMode(current => (current === 'account' ? 'key' : 'account'));
  };

  const submitAccount = async () => {
    const address = email.trim();
    if (!address) {
      setError(t('login.emailRequired'));
      return;
    }
    if (!password) {
      setError(t('login.passwordRequired'));
      return;
    }
    try {
      const result = await authApi.login(address, password);
      if (!result?.token || typeof result.token !== 'string') {
        // A 200 that is not the gateway's answer (a proxy serving the app's HTML for a misrouted
        // /api) must not sign anyone in.
        setError(t('login.connectionError'));
        return;
      }
      onLogin(
        result.token,
        result.role,
        typeof result.engineType === 'string' ? result.engineType : undefined,
        result.scoped === true,
        undefined,
        undefined,
        result.user ? { id: result.user.id, email: result.user.email, name: result.user.name } : undefined,
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        // One message for an unknown address, a wrong password and a disabled account: the route
        // deliberately does not say which.
        setError(t('login.invalidCredentials'));
      } else if (status === 429) {
        setError(t('login.tooManyAttempts'));
      } else {
        setError(t('login.connectionError'));
      }
    }
  };

  const submitKey = async () => {
    // The stored key is matched against key prefixes elsewhere, so a pasted space must not reach it.
    const key = apiKey.trim();
    if (!key) {
      setError(t('login.apiKeyRequired'));
      return;
    }
    try {
      const response = await fetch(`${API_BASE_URL}/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': key,
        },
      });

      if (response.ok) {
        // The validate body already carries the key's role — hand it up so the app can set it
        // directly instead of re-validating the same key a second time.
        const data: {
          valid?: unknown;
          role?: string;
          engineType?: string;
          scoped?: unknown;
          keyId?: string;
          keyName?: string;
        } = await response.json().catch(() => ({}));
        // A 200 is the gateway's answer only if it says the key is valid, as the startup check requires: a reverse proxy
        // serving the app's HTML for a misrouted /api would otherwise sign any typed text in as a viewer.
        if (data.valid !== true) {
          setError(t('login.connectionError'));
          return;
        }
        onLogin(
          key,
          data.role,
          typeof data.engineType === 'string' ? data.engineType : undefined,
          data.scoped === true,
          typeof data.keyId === 'string' ? data.keyId : undefined,
          typeof data.keyName === 'string' ? data.keyName : undefined,
        );
      } else {
        // A 5xx, or a body that is not the gateway's JSON (a proxy error page while it restarts), says
        // nothing about the key; a refusal keeps the gateway's reason (expired, revoked, rate limited).
        const errorData: { message?: unknown } = await response.json().catch(() => ({}));
        const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
        setError(reason || t(response.status === 401 ? 'login.invalidKey' : 'login.connectionError'));
      }
    } catch {
      setError(t('login.connectionError'));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      if (mode === 'account') await submitAccount();
      else await submitKey();
    } finally {
      setIsLoading(false);
    }
  };

  const errorId = mode === 'account' ? 'login-error' : 'apiKey-error';

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/alim-connect-icon.png" alt="ALIM Connect" className="logo-icon" />
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              // ISO date (YYYYMMDD) so the format is stable across locales/regions instead of the
              // locale-dependent toLocaleDateString() which renders differently per browser region.
              date: new Date(__BUILD_TIME__).toISOString().slice(0, 10).replace(/-/g, ''),
            })}
          </span>
        </div>

        <div className="login-language">
          <Languages size={18} />
          <CustomSelect
            value={currentLang}
            onChange={value => changeLanguage(value as SupportedLanguage)}
            options={languageOptions.map(opt => ({ value: opt.value, label: opt.label }))}
            ariaLabel={t('common.language')}
          />
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {mode === 'account' ? (
            <>
              <div className="input-group">
                <label htmlFor="email">{t('login.email')}</label>
                <div className="input-wrapper">
                  <input
                    id="email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder={t('login.emailPlaceholder')}
                    className={error ? 'error' : ''}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                  />
                </div>
              </div>
              <div className="input-group">
                <label htmlFor="password">{t('common.password')}</label>
                <div className="input-wrapper">
                  <input
                    id="password"
                    type={showSecret ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t('login.passwordPlaceholder')}
                    className={error ? 'error' : ''}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                  />
                  <button
                    type="button"
                    className="toggle-visibility"
                    onClick={() => setShowSecret(!showSecret)}
                    aria-label={showSecret ? t('common.hidePassword') : t('common.showPassword')}
                  >
                    {showSecret ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="input-group">
              <label htmlFor="apiKey">{t('login.apiKey')}</label>
              <div className="input-wrapper">
                <input
                  id="apiKey"
                  type={showSecret ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={t('login.apiKeyPlaceholder')}
                  className={error ? 'error' : ''}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowSecret(!showSecret)}
                  aria-label={showSecret ? t('common.hideApiKey') : t('common.showApiKey')}
                >
                  {showSecret ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>
          )}

          {error && (
            <span id={errorId} className="error-message" role="alert">
              {error}
            </span>
          )}

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading
              ? t(mode === 'account' ? 'login.signingIn' : 'login.connecting')
              : t(mode === 'account' ? 'login.signIn' : 'login.connect')}
          </button>

          <button type="button" className="login-mode-toggle" onClick={switchMode}>
            {t(mode === 'account' ? 'login.useApiKey' : 'login.useAccount')}
          </button>
        </form>

        <p className="login-help">
          {t('login.help')}{' '}
          <a href="https://docs.open-wa.org" target="_blank" rel="noopener noreferrer">
            {t('login.viewDocs')}
          </a>
        </p>
      </div>

      <footer className="login-footer">
        <span>{t('login.footer')}</span>
        <a
          href="https://github.com/rmyndharis/OpenWA"
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
          aria-label="GitHub"
        >
          <GithubIcon size={18} />
        </a>
      </footer>
    </div>
  );
}
