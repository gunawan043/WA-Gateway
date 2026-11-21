import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS } from './permissions';

/**
 * Structural gate for the Fase 1 conversion (docs/35 §35.8.2, "Struktural").
 *
 * - Every `@RequirePermission` argument must be a catalogue name, so a typo cannot create a
 *   permission nothing grants (which would be a silent 403 for everyone).
 * - The set of wired permissions is pinned. Fase 1a wires only the two assignment routes; each
 *   later stage adds its own, and this list is where that addition is acknowledged.
 * - The number of `@RequireRole` points may only shrink. Adding one re-opens a surface the design
 *   has already accounted for, and would bypass the permission model for new code.
 */
const SRC = join(__dirname, '..', '..');

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) controllerFiles(full, out);
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function scan(pattern: RegExp): Array<{ file: string; value: string }> {
  const out: Array<{ file: string; value: string }> = [];
  for (const file of controllerFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) out.push({ file: file.slice(SRC.length + 1), value: match[1] });
  }
  return out;
}

describe('permission coverage', () => {
  const requirePermission = scan(/@RequirePermission\(([^)]*)\)/g).flatMap(({ file, value }) =>
    [...value.matchAll(/'([a-z][a-z.]*)'/g)].map(match => ({ file, value: match[1] })),
  );
  const requireRole = scan(/@RequireRole\(/g);

  it('names only catalogue permissions in @RequirePermission', () => {
    const known = new Set<string>(PERMISSIONS);
    expect(
      requirePermission.filter(entry => !known.has(entry.value)).map(entry => `${entry.file}: ${entry.value}`),
    ).toEqual([]);
  });

  it('wires exactly the permissions Fase 1a introduces', () => {
    // Adding a route that demands a permission means adding its name here, in the same change.
    expect([...new Set(requirePermission.map(entry => entry.value))].sort()).toEqual(['role.assign', 'role.read']);
  });

  it('does not grow the @RequireRole surface', () => {
    // 186 when Fase 1a landed (51 ADMIN, 119 OPERATOR, 16 VIEWER). The list may only shrink as
    // routes move to @RequirePermission.
    expect(requireRole.length).toBeLessThanOrEqual(186);
    expect(requireRole.length).toBeGreaterThan(0);
  });
});
