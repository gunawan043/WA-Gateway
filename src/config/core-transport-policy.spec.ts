import {
  assertCoreTransportAllowed,
  coreTransportProblems,
  insecureCoreOriginReason,
  insecureCoreUrlReason,
} from './core-transport-policy';

/**
 * Production must refuse a plaintext ALIM Core. The approval and SSO keys travel in request headers
 * and the handoff code in a body, so an `http://` hop lets anyone on the path read and replay them.
 * These cases pin the boundary: what is refused, what stays allowed (loopback development), and that
 * `https` is never refused for any other reason.
 */
describe('insecureCoreUrlReason', () => {
  it('accepts https on any host', () => {
    expect(insecureCoreUrlReason('https://alim.example.id')).toBeNull();
    expect(insecureCoreUrlReason('https://core.example.internal:8443')).toBeNull();
    expect(insecureCoreUrlReason('  https://alim.example.id  ')).toBeNull();
  });

  it('refuses http on a reachable host, naming the variable and never the value', () => {
    const reason = insecureCoreUrlReason('http://alim.example.id');
    expect(reason).toContain('ALIM_CORE_BASE_URL');
    expect(reason).toContain('https://');
    expect(reason).not.toContain('alim.example.id');
  });

  it('allows http only on loopback, where there is no hop to intercept', () => {
    for (const local of ['http://localhost:8001', 'http://127.0.0.1:8001', 'http://[::1]:8001', 'http://127.5.5.5']) {
      expect(insecureCoreUrlReason(local)).toBeNull();
    }
  });

  it('does not let a loopback-looking host pass', () => {
    expect(insecureCoreUrlReason('http://localhost.example.com')).not.toBeNull();
    expect(insecureCoreUrlReason('http://127.0.0.1.example.com')).not.toBeNull();
    expect(insecureCoreUrlReason('http://10.0.0.5:8001')).not.toBeNull();
  });

  it('refuses a scheme that is neither http nor https, and a value that is not a URL', () => {
    expect(insecureCoreUrlReason('ftp://core.example.id')).toContain('https://');
    expect(insecureCoreUrlReason('core.example.id')).toBe('ALIM_CORE_BASE_URL is not a URL');
  });

  it('leaves an unset URL to the approval client policy, which already refuses it in production', () => {
    expect(insecureCoreUrlReason('')).toBeNull();
  });
});

describe('insecureCoreOriginReason', () => {
  it('accepts https and loopback http, and leaves invalid values to parseCoreWebOrigin', () => {
    expect(insecureCoreOriginReason('https://alim.example.id')).toBeNull();
    expect(insecureCoreOriginReason('http://localhost:8001')).toBeNull();
    expect(insecureCoreOriginReason('')).toBeNull();
    expect(insecureCoreOriginReason('not a url')).toBeNull();
  });

  it('refuses http on a reachable host', () => {
    expect(insecureCoreOriginReason('http://alim.example.id')).toContain('ALIM_CORE_WEB_ORIGIN');
  });
});

describe('the production gate', () => {
  const production = 'production';

  it('refuses the boot, naming every problem at once', () => {
    expect(() =>
      assertCoreTransportAllowed(
        { coreBaseUrl: 'http://alim.example.id', coreWebOrigin: 'http://alim.example.id' },
        production,
      ),
    ).toThrow(/ALIM_CORE_BASE_URL[\s\S]*ALIM_CORE_WEB_ORIGIN/);
  });

  it('allows a correct production configuration', () => {
    expect(() =>
      assertCoreTransportAllowed(
        { coreBaseUrl: 'https://alim.example.id', coreWebOrigin: 'https://alim.example.id' },
        production,
      ),
    ).not.toThrow();
  });

  // With the integration switched off there is no Core URL in use, so production must be able to
  // boot with none at all — that is what lets ALIM Connect run before Core is agreed.
  describe('with the Core integration disabled', () => {
    it('boots in production with no Core URL at all', () => {
      expect(() => assertCoreTransportAllowed({}, production, true)).not.toThrow();
    });

    it('still refuses a plaintext Core web origin, because SSO origin is a browser trust decision', () => {
      expect(() => assertCoreTransportAllowed({ coreWebOrigin: 'http://alim.example.id' }, production, true)).toThrow(
        /ALIM_CORE_WEB_ORIGIN/,
      );
    });

    it('still validates a Core URL that IS configured', () => {
      // Turning the integration off must not become a way to keep a plaintext URL in the config
      // until someone flips it back on in a hurry.
      expect(() => assertCoreTransportAllowed({ coreBaseUrl: 'http://alim.example.id' }, production, true)).toThrow(
        /ALIM_CORE_BASE_URL/,
      );
    });

    it('leaves the enabled path exactly as strict as before', () => {
      expect(() => assertCoreTransportAllowed({}, production, false)).not.toThrow();
      expect(() => assertCoreTransportAllowed({ coreBaseUrl: 'http://alim.example.id' }, production, false)).toThrow(
        /ALIM_CORE_BASE_URL/,
      );
    });
  });

  it('leaves development free to use loopback http', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      expect(() =>
        assertCoreTransportAllowed(
          { coreBaseUrl: 'http://localhost:8001', coreWebOrigin: 'http://localhost:8001' },
          nodeEnv,
        ),
      ).not.toThrow();
    }
  });

  it('reports problems only when there are any', () => {
    expect(coreTransportProblems({ coreBaseUrl: 'https://a.example', coreWebOrigin: 'https://a.example' })).toEqual([]);
    expect(coreTransportProblems({ coreBaseUrl: 'http://a.example' })).toHaveLength(1);
  });
});
