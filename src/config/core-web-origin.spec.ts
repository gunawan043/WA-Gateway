import { frameAncestorsFor, isAllowedHandoffOrigin, parseCoreWebOrigin } from './core-web-origin';

describe('parseCoreWebOrigin', () => {
  it('accepts an https origin, with or without a trailing slash', () => {
    expect(parseCoreWebOrigin('https://core.example.com')).toBe('https://core.example.com');
    expect(parseCoreWebOrigin('https://core.example.com/')).toBe('https://core.example.com');
    expect(parseCoreWebOrigin('  https://core.example.com  ')).toBe('https://core.example.com');
  });

  it('accepts an http origin only as a literal origin (loopback development)', () => {
    expect(parseCoreWebOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('refuses a wildcard instead of narrowing it', () => {
    expect(parseCoreWebOrigin('https://*.example.com')).toBeNull();
    expect(parseCoreWebOrigin('*')).toBeNull();
  });

  it('refuses a value that is a page, not an origin', () => {
    expect(parseCoreWebOrigin('https://core.example.com/app')).toBeNull();
    expect(parseCoreWebOrigin('https://core.example.com/?x=1')).toBeNull();
    expect(parseCoreWebOrigin('https://core.example.com/#frag')).toBeNull();
  });

  it('refuses credentials, non-http schemes and blanks', () => {
    expect(parseCoreWebOrigin('https://user:pass@core.example.com')).toBeNull();
    expect(parseCoreWebOrigin('javascript:alert(1)')).toBeNull();
    expect(parseCoreWebOrigin('file:///etc/passwd')).toBeNull();
    expect(parseCoreWebOrigin('')).toBeNull();
    expect(parseCoreWebOrigin(undefined)).toBeNull();
    expect(parseCoreWebOrigin(null)).toBeNull();
  });

  it('normalises the default port away, because the browser Origin header does', () => {
    expect(parseCoreWebOrigin('https://core.example.com:443')).toBe('https://core.example.com');
  });
});

describe('frameAncestorsFor', () => {
  it('keeps self when no Core origin is configured', () => {
    expect(frameAncestorsFor(null)).toEqual(["'self'"]);
  });

  it('adds the exact Core origin alongside self, never a wildcard', () => {
    expect(frameAncestorsFor('https://core.example.com')).toEqual(["'self'", 'https://core.example.com']);
  });
});

describe('isAllowedHandoffOrigin', () => {
  const core = 'https://core.example.com';

  it('accepts the exact configured origin', () => {
    expect(isAllowedHandoffOrigin(core, undefined, core)).toBe(true);
    expect(isAllowedHandoffOrigin('https://core.example.com/', undefined, core)).toBe(true);
  });

  it('refuses a different origin, a look-alike host and a wildcard-ish value', () => {
    expect(isAllowedHandoffOrigin('https://evil.example', undefined, core)).toBe(false);
    expect(isAllowedHandoffOrigin('https://core.example.com.evil.example', undefined, core)).toBe(false);
    expect(isAllowedHandoffOrigin('https://core.example.com:8443', undefined, core)).toBe(false);
  });

  it('falls back to the Referer origin when Origin is absent', () => {
    expect(isAllowedHandoffOrigin(undefined, 'https://core.example.com/page/whatsapp', core)).toBe(true);
    expect(isAllowedHandoffOrigin(undefined, 'https://evil.example/page', core)).toBe(false);
  });

  it('refuses a missing or sandboxed Origin', () => {
    expect(isAllowedHandoffOrigin(undefined, undefined, core)).toBe(false);
    expect(isAllowedHandoffOrigin('null', undefined, core)).toBe(false);
    expect(isAllowedHandoffOrigin('', '', core)).toBe(false);
  });

  it('refuses everything when SSO is not configured', () => {
    expect(isAllowedHandoffOrigin(core, core, null)).toBe(false);
  });
});
