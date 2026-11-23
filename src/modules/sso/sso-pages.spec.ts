import { renderHandoffErrorPage, renderHandoffLoadingPage, renderHandoffSuccessPage } from './sso-pages';

describe('SSO handoff pages', () => {
  const nonce = 'nonce-value';

  it('writes the token to sessionStorage and replaces the document', () => {
    const html = renderHandoffSuccessPage({ nonce, coreOrigin: 'https://core.example.com', token: 'owa_s1_abc' });

    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).toContain(`sessionStorage.setItem('openwa_api_key', "owa_s1_abc")`);
    expect(html).toContain("window.location.replace('/')");
    // The token is not in a URL, and the page is not cached.
    expect(html).not.toContain('?token=');
  });

  it('escapes a token that could close the script element', () => {
    const html = renderHandoffSuccessPage({ nonce, coreOrigin: null, token: '</script><script>alert(1)' });

    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('offers a way back to Core only when the origin is configured', () => {
    const withCore = renderHandoffErrorPage({
      nonce,
      coreOrigin: 'https://core.example.com',
      title: 'Handoff kedaluwarsa',
      message: 'Kode sudah kedaluwarsa.',
    });
    expect(withCore).toContain('href="https://core.example.com"');
    expect(withCore).toContain('Kembali ke ALIM Core');

    const withoutCore = renderHandoffErrorPage({
      nonce,
      coreOrigin: null,
      title: 'Gagal',
      message: 'Coba lagi.',
    });
    expect(withoutCore).not.toContain('Kembali ke ALIM Core');
  });

  it('escapes error copy instead of injecting it as markup', () => {
    const html = renderHandoffErrorPage({
      nonce,
      coreOrigin: null,
      title: '<img src=x onerror=alert(1)>',
      message: 'a & b',
    });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('renders a loading page that creates nothing and carries no token', () => {
    const html = renderHandoffLoadingPage({ nonce, coreOrigin: 'https://core.example.com' });

    expect(html).toContain('Menghubungkan ke ALIM Connect');
    expect(html).not.toContain('openwa_api_key');
    expect(html).not.toContain('sessionStorage');
  });
});
