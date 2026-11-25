import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AlimCoreSettingsService } from './alim-core-settings.service';

/**
 * Every one of these guards a way the page could either leak a secret or take the site down on the
 * next restart, so each is asserted against a real temporary overlay rather than a mock.
 */
describe('AlimCoreSettingsService', () => {
  let directory: string;
  let previousCwd: string;
  let service: AlimCoreSettingsService;

  const SECRET = 'sso-key-value-that-must-not-escape';

  beforeEach(() => {
    previousCwd = process.cwd();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alim-core-settings-'));
    fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
    process.chdir(directory);
    service = new AlimCoreSettingsService();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function overlay(): Record<string, string> {
    const file = path.join(directory, 'data', '.env.generated');
    if (!fs.existsSync(file)) return {};
    const parsed = require('dotenv').parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    return parsed;
  }

  describe('reading', () => {
    it('reports a stored secret as set without ever returning its value', () => {
      service.save({ ALIM_CONNECT_CORE_CLIENT: 'disabled', ALIM_CONNECT_SSO_KEY: SECRET }, 'production');
      const view = service.read();

      const field = view.fields.find(item => item.key === 'ALIM_CONNECT_SSO_KEY');
      expect(field?.isSet).toBe(true);
      expect(field?.value).toBe('');
      expect(JSON.stringify(view)).not.toContain(SECRET);
    });

    it('reports an absent secret as unset', () => {
      const field = service.read().fields.find(item => item.key === 'ALIM_CONNECT_SSO_KEY');
      expect(field?.isSet).toBe(false);
    });

    it('never leaks any secret key, whichever one is stored', () => {
      service.save(
        {
          ALIM_CONNECT_CORE_CLIENT: 'disabled',
          ALIM_CONNECT_SSO_KEY: SECRET,
          ALIM_CORE_APPROVAL_API_KEY: `${SECRET}-approval`,
          ALIM_CONNECT_INGEST_KEY: `${SECRET}-ingest`,
        },
        'production',
      );
      const serialised = JSON.stringify(service.read());
      expect(serialised).not.toContain(SECRET);
    });

    it('flags a stored value the running process has not loaded as pending a restart', () => {
      delete process.env.ALIM_CONNECT_SSO_AUDIENCE;
      service.save({ ALIM_CONNECT_CORE_CLIENT: 'disabled', ALIM_CONNECT_SSO_AUDIENCE: 'connect-v2' }, 'production');

      const field = service.read().fields.find(item => item.key === 'ALIM_CONNECT_SSO_AUDIENCE');
      expect(field?.pendingRestart).toBe(true);
      expect(service.read().restartRequired).toBe(true);
    });

    it('exposes the default when nothing is stored', () => {
      delete process.env.ALIM_CONNECT_SSO_AUDIENCE;
      const field = service.read().fields.find(item => item.key === 'ALIM_CONNECT_SSO_AUDIENCE');
      expect(field?.value).toBe('connect');
    });
  });

  describe('saving', () => {
    it('keeps a stored secret when the form submits it empty', () => {
      service.save({ ALIM_CONNECT_CORE_CLIENT: 'disabled', ALIM_CONNECT_SSO_KEY: SECRET }, 'production');
      service.save({ ALIM_CONNECT_SSO_KEY: '' }, 'production');
      expect(overlay().ALIM_CONNECT_SSO_KEY).toBe(SECRET);
    });

    it('leaves keys that were not submitted untouched', () => {
      service.save(
        { ALIM_CONNECT_CORE_CLIENT: 'disabled', ALIM_CORE_BASE_URL: 'https://alim.example.id', ALIM_CONNECT_SSO_AUDIENCE: 'connect' },
        'production',
      );
      service.save({ ALIM_CORE_BASE_URL: 'https://alim2.example.id' }, 'production');

      expect(overlay().ALIM_CONNECT_SSO_AUDIENCE).toBe('connect');
      expect(overlay().ALIM_CORE_BASE_URL).toBe('https://alim2.example.id');
    });

    it('preserves unrelated lines already in the overlay', () => {
      fs.writeFileSync(path.join(directory, 'data', '.env.generated'), 'REDIS_ENABLED=true\n');
      service.save({ ALIM_CORE_BASE_URL: 'https://alim.example.id' }, 'production');
      expect(overlay().REDIS_ENABLED).toBe('true');
    });

    it('writes nothing when a value is malformed', () => {
      const result = service.save({ ALIM_CORE_BASE_URL: 'http://insecure.example.id' }, 'production');

      expect(result.saved).toBe(false);
      expect(result.errors?.ALIM_CORE_BASE_URL).toBeDefined();
      expect(overlay()).toEqual({});
    });

    it('refuses a wildcard origin', () => {
      const result = service.save({ ALIM_CORE_WEB_ORIGIN: 'https://*.example.id' }, 'production');
      expect(result.saved).toBe(false);
    });

    it('refuses an origin carrying a path, which could never match a browser Origin header', () => {
      const result = service.save({ ALIM_CORE_WEB_ORIGIN: 'https://alim.example.id/app' }, 'production');
      expect(result.saved).toBe(false);
      expect(result.errors?.ALIM_CORE_WEB_ORIGIN).toBeDefined();
    });

    it('trims whitespace from a pasted key, which would otherwise be a different key to Core', () => {
      service.save({ ALIM_CONNECT_CORE_CLIENT: 'disabled', ALIM_CONNECT_SSO_KEY: `  ${SECRET}\n` }, 'production');
      expect(overlay().ALIM_CONNECT_SSO_KEY).toBe(SECRET);
    });

    it('refuses an integer that is not a whole number', () => {
      const result = service.save({ ALIM_CORE_TIMEOUT_MS: '5s' }, 'production');
      expect(result.saved).toBe(false);
    });

    it('refuses a non-boolean for a boolean field', () => {
      const result = service.save({ ALIM_CONNECT_REPLY_UNKNOWN: 'yes' }, 'production');
      expect(result.saved).toBe(false);
    });

    it('writes the overlay owner-only', () => {
      service.save({ ALIM_CONNECT_CORE_CLIENT: 'disabled', ALIM_CONNECT_SSO_KEY: SECRET }, 'production');
      const mode = fs.statSync(path.join(directory, 'data', '.env.generated')).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('the combination that would fail the next boot', () => {
    it('refuses mock in production rather than saving a value that stops the app starting', () => {
      const result = service.save({ ALIM_CONNECT_CORE_CLIENT: 'mock' }, 'production');
      expect(result.saved).toBe(false);
      expect(result.message).toContain('mock');
      expect(overlay().ALIM_CONNECT_CORE_CLIENT).toBeUndefined();
    });

    it('refuses http in production without an address and a key', () => {
      const result = service.save({ ALIM_CONNECT_CORE_CLIENT: 'http' }, 'production');
      expect(result.saved).toBe(false);
      expect(result.message).toContain('Alamat ALIM Core');
    });

    it('accepts http in production once the address and key are present', () => {
      fs.writeFileSync(
        path.join(directory, 'data', '.env.generated'),
        ['ALIM_CORE_BASE_URL=https://alim.example.id', `ALIM_CORE_APPROVAL_API_KEY=${SECRET}`].join('\n'),
      );
      const result = service.save({ ALIM_CONNECT_CORE_CLIENT: 'http' }, 'production');
      expect(result.saved).toBe(true);
    });

    it('accepts disabled in production', () => {
      expect(service.save({ ALIM_CONNECT_CORE_CLIENT: 'disabled' }, 'production').saved).toBe(true);
    });

    it('leaves development free to use mock', () => {
      expect(service.save({ ALIM_CONNECT_CORE_CLIENT: 'mock' }, 'development').saved).toBe(true);
    });
  });

  describe('readiness', () => {
    it('reports SSO ready only with mode http, both URLs and a key', () => {
      expect(service.read().ready.sso).toBe(false);
      service.save(
        {
          ALIM_CONNECT_CORE_CLIENT: 'disabled',
          ALIM_CORE_BASE_URL: 'https://alim.example.id',
          ALIM_CORE_WEB_ORIGIN: 'https://alim.example.id',
          ALIM_CONNECT_SSO_KEY: SECRET,
        },
        'production',
      );
      expect(service.read().ready.sso).toBe(false);

      service.save({ ALIM_CONNECT_CORE_CLIENT: 'http', ALIM_CORE_APPROVAL_API_KEY: SECRET }, 'production');
      expect(service.read().ready.sso).toBe(true);
    });
  });
});
