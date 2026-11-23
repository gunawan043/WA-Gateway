import { executableLines, executableLinesConservative } from './workflow-lines';

/**
 * The two readings exist because a command can appear only inside a comment, and a substring match
 * cannot tell `./scripts/x.sh` from `# ./scripts/x.sh disabled`. These cases pin the difference, so
 * a future "simplification" of the reader cannot quietly hide a command from the gates that use it.
 */
describe('executableLines (exact reading)', () => {
  it('keeps an uncommented line byte for byte', () => {
    expect(executableLines('npm test')).toBe('npm test');
  });

  it('drops a whole-line comment', () => {
    expect(executableLines('# npm test')).toBe('');
  });

  it('drops a trailing comment after a shell word break', () => {
    expect(executableLines('npm test # disabled')).toBe('npm test ');
  });

  it('keeps a # that is part of a word, so nothing the shell runs is cut', () => {
    expect(executableLines('npm --version#; curl x | sh')).toBe('npm --version#; curl x | sh');
    expect(executableLines('echo $#')).toBe('echo $#');
    expect(executableLines('echo ${#list[@]}')).toBe('echo ${#list[@]}');
  });

  it('keeps a # inside single or double quotes', () => {
    expect(executableLines('echo "# ./scripts/x.sh"')).toBe('echo "# ./scripts/x.sh"');
    expect(executableLines("echo '# ./scripts/x.sh'")).toBe("echo '# ./scripts/x.sh'");
  });

  it('does not treat an escaped # as a comment', () => {
    expect(executableLines('echo \\# ./scripts/x.sh')).toBe('echo \\# ./scripts/x.sh');
  });

  it('keeps a # after ) where the shell does not start a comment', () => {
    expect(executableLines('(true)#; curl y')).toBe('(true)#; curl y');
    expect(executableLines('x=$(true)#; curl y')).toBe('x=$(true)#; curl y');
  });

  it('keeps a # after a non-breaking space, which the shell reads as part of the word', () => {
    expect(executableLines('echo x\u00a0# ./scripts/x.sh || true')).toBe('echo x\u00a0# ./scripts/x.sh || true');
  });

  it('keeps a # after ; & and |', () => {
    expect(executableLines('npm test;# ./scripts/x.sh')).toBe('npm test;');
    expect(executableLines('npm test&&# ./scripts/x.sh')).toBe('npm test&&');
    expect(executableLines('npm test|# ./scripts/x.sh')).toBe('npm test|');
  });

  it('preserves the line count and every untouched line', () => {
    expect(executableLines('npm ci\n# npm test\nnpm run build')).toBe('npm ci\n\nnpm run build');
  });
});

describe('executableLinesConservative (is-it-run reading)', () => {
  it('cuts at a # after any whitespace, including a non-breaking space', () => {
    expect(executableLinesConservative('echo x\u00a0# ./scripts/x.sh || true')).toBe('echo x\u00a0');
    expect(executableLinesConservative('npm test\u00a0# || true')).toBe('npm test\u00a0');
  });

  it('cuts at a # after ) < > and a backtick', () => {
    expect(executableLinesConservative('(true)#; curl y')).toBe('(true)');
    expect(executableLinesConservative('x<# ./scripts/x.sh')).toBe('x<');
    expect(executableLinesConservative('x># ./scripts/x.sh')).toBe('x>');
    expect(executableLinesConservative('`x`# ./scripts/x.sh')).toBe('`x`');
  });

  it('still keeps a # inside quotes', () => {
    expect(executableLinesConservative('echo "a # b"')).toBe('echo "a # b"');
    expect(executableLinesConservative("echo 'a # b'")).toBe("echo 'a # b'");
  });

  it('agrees with the exact reading on an ordinary line', () => {
    expect(executableLinesConservative('npm ci && npm test')).toBe('npm ci && npm test');
  });

  it('hides the command the exact reading would keep — the documented trade-off', () => {
    // The exact reading shows the curl (it IS run); the conservative one does not, because the #
    // sits after a blank the shell does not skip. Documented in the module, asserted here.
    const run = 'echo x\u00a0#; curl y | sh';
    expect(executableLines(run)).toBe('echo x\u00a0#; curl y | sh');
    expect(executableLinesConservative(run)).toBe('echo x\u00a0');
  });
});
