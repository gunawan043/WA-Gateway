import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { isEnvPinned } from '../../config/env-precedence';
import { writeSecretFile } from '../../common/utils/secret-file';
import { createLogger } from '../../common/services/logger.service';
import {
  ALIM_CORE_FIELDS,
  SECRET_KEYS,
  crossFieldProblem,
  normalizeFieldValue,
  type AlimCoreFieldSpec,
} from './alim-core-fields';

const logger = createLogger('AlimCoreSettings');

/** One field as the dashboard renders it. A secret is reported by presence, never by value. */
export interface AlimCoreFieldValue {
  key: string;
  section: AlimCoreFieldSpec['section'];
  label: string;
  kind: AlimCoreFieldSpec['kind'];
  help: string;
  choices?: readonly string[];
  optional?: boolean;
  defaultValue?: string;
  /** The effective value. Always `''` for a secret. */
  value: string;
  /** Secrets only: whether a value is stored. Undefined for non-secrets. */
  isSet?: boolean;
  /** Where the effective value came from. */
  source: 'environment' | 'overlay' | 'default' | 'unset';
  /** A value is stored but the running process has not loaded it yet. */
  pendingRestart: boolean;
}

export interface AlimCoreSettingsView {
  fields: AlimCoreFieldValue[];
  /** True when at least one stored value differs from what this process is running. */
  restartRequired: boolean;
  /** Whether the integration currently satisfies its own startup gate. */
  ready: { sso: boolean; approval: boolean };
}

export interface SaveResult {
  saved: boolean;
  restartRequired: boolean;
  /** Field-level messages, keyed by env name. Never contains a secret. */
  errors?: Record<string, string>;
  message?: string;
}

/**
 * Reads and writes the ALIM Core section of `data/.env.generated`.
 *
 * The file this touches is the dashboard-written overlay the application already merges on the next
 * boot — the same one the infrastructure form uses. Nothing here edits `.env`, which belongs to the
 * operator and is often outside the application's writable tree.
 *
 * Three rules the callers must not have to restate:
 *
 *  1. A secret is never read back. The page gets `isSet`, the same way the infrastructure form does,
 *     and an empty submission preserves what is stored rather than clearing it.
 *  2. Validation completes before a single byte is written, so a refused save leaves the previous
 *     overlay exactly as it was.
 *  3. A save only lands in the overlay; the running process keeps its boot-time values until a
 *     restart. `pendingRestart` is how the page says so instead of claiming a change is live.
 */
@Injectable()
export class AlimCoreSettingsService {
  private overlayPath(): string {
    return path.resolve(process.cwd(), 'data', '.env.generated');
  }

  private readOverlay(): Record<string, string> {
    const file = this.overlayPath();
    return fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file, 'utf8')) : {};
  }

  /**
   * The value the running process actually holds for a key.
   *
   * `process.env` is authoritative for what this process does, and a pinned key (one supplied by the
   * host or by `.env`) outranks the overlay at every boot, so the overlay can hold a value that will
   * never apply. The page reports the effective value and flags the rest as pending.
   */
  private effective(key: string, overlay: Record<string, string>): { value: string; source: AlimCoreFieldValue['source'] } {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined && fromProcess !== '') {
      return { value: fromProcess, source: 'environment' };
    }
    const fromOverlay = overlay[key];
    if (fromOverlay !== undefined && fromOverlay !== '') {
      return { value: fromOverlay, source: 'overlay' };
    }
    return { value: '', source: 'unset' };
  }

  read(): AlimCoreSettingsView {
    const overlay = this.readOverlay();
    let restartRequired = false;

    const fields = ALIM_CORE_FIELDS.map((spec): AlimCoreFieldValue => {
      const stored = overlay[spec.key] ?? '';
      const { value, source } = this.effective(spec.key, overlay);

      // "Stored but not running" is the whole point of the indicator: a saved key that the process
      // never loaded looks identical to a working one unless the two are compared. The comparison is
      // against process.env directly rather than the effective value, because the effective value
      // falls back to a documented default that was never stored and so cannot be pending.
      const pendingRestart = stored !== '' && process.env[spec.key] !== stored;
      if (pendingRestart) restartRequired = true;

      const base: Omit<AlimCoreFieldValue, 'value'> = {
        key: spec.key,
        section: spec.section,
        label: spec.label,
        kind: spec.kind,
        help: spec.help,
        source,
        pendingRestart,
      };
      if (spec.choices) base.choices = spec.choices;
      if (spec.optional) base.optional = spec.optional;
      if (spec.defaultValue !== undefined) base.defaultValue = spec.defaultValue;

      if (spec.kind === 'secret') {
        const isSet = value !== '' || (stored !== '' && !isEnvPinned(spec.key));
        return { ...base, value: '', isSet, source: isSet ? source : 'unset' };
      }

      return { ...base, value: value || spec.defaultValue || '' };
    });

    const lookup = (key: string): string => fields.find(field => field.key === key)?.value ?? '';
    const mode = lookup('ALIM_CONNECT_CORE_CLIENT').trim().toLowerCase();
    const ssoKeySet = fields.find(field => field.key === 'ALIM_CONNECT_SSO_KEY')?.isSet === true;
    const approvalKeySet = fields.find(field => field.key === 'ALIM_CORE_APPROVAL_API_KEY')?.isSet === true;

    return {
      fields,
      restartRequired,
      ready: {
        sso: mode === 'http' && lookup('ALIM_CORE_BASE_URL') !== '' && lookup('ALIM_CORE_WEB_ORIGIN') !== '' && ssoKeySet,
        approval: mode === 'http' && lookup('ALIM_CORE_BASE_URL') !== '' && approvalKeySet,
      },
    };
  }

  /**
   * Validates and stores the submitted values.
   *
   * `values` may be partial: a key absent from it is left untouched. An empty string CLEARS a
   * non-secret key and PRESERVES a secret, because an empty password field in a form means "unchanged"
   * far more often than it means "delete this".
   */
  save(values: Record<string, string>, nodeEnv: string | undefined): SaveResult {
    const overlay = this.readOverlay();
    const errors: Record<string, string> = {};
    const updates: Record<string, string> = {};

    for (const spec of ALIM_CORE_FIELDS) {
      if (!(spec.key in values)) continue;

      const raw = values[spec.key];

      if (spec.kind === 'secret' && raw.trim() === '') {
        // Empty submission on a secret: keep whatever is stored.
        const stored = overlay[spec.key] ?? process.env[spec.key] ?? '';
        if (stored !== '') updates[spec.key] = stored;
        continue;
      }

      if (isEnvPinned(spec.key) && process.env[spec.key] !== undefined) {
        errors[spec.key] = `Nilai ini ditetapkan oleh .env atau environment host; ubah di sana, bukan dari halaman ini.`;
        continue;
      }

      const normalized = normalizeFieldValue(spec, raw, nodeEnv);
      if (!normalized.ok) {
        errors[spec.key] = normalized.message;
        continue;
      }
      updates[spec.key] = normalized.value;
    }

    if (Object.keys(errors).length > 0) {
      return { saved: false, restartRequired: false, errors };
    }

    const merged = { ...overlay, ...updates };
    const problem = crossFieldProblem(merged, nodeEnv, updates);
    if (problem) {
      return { saved: false, restartRequired: false, message: problem };
    }

    this.write(overlay, updates);
    logger.log('ALIM Core settings saved', { keys: Object.keys(updates) });

    return { saved: true, restartRequired: true };
  }

  /**
   * Rewrites the overlay with the submitted keys replaced and every other line preserved.
   *
   * Written to a staging file beside the target and renamed over it, so a failure part-way through
   * cannot leave a truncated overlay for the next boot to load. Values are re-parsed as a whole file
   * before the rename because a quoted value can swallow a later line.
   */
  private write(overlay: Record<string, string>, updates: Record<string, string>): void {
    const merged = { ...overlay, ...updates };
    const lines = Object.entries(merged)
      .filter(([, value]) => value !== '')
      .map(([key, value]) => {
        const encoded = encodeValue(key, value);
        if (encoded === undefined) {
          throw new Error(`Nilai untuk ${key} tidak dapat ditulis ulang dengan aman.`);
        }
        return `${key}=${encoded}`;
      });
    const contents = `${lines.join('\n')}\n`;

    const expected = { ...merged };
    for (const key of Object.keys(expected)) {
      if (expected[key] === '') delete expected[key];
    }
    const actual = dotenv.parse(contents);
    const drifted = Object.keys(expected).find(key => actual[key] !== expected[key]);
    if (drifted !== undefined) {
      throw new Error(`Nilai untuk ${drifted} tidak terbaca kembali sama setelah ditulis.`);
    }

    const target = this.overlayPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const staged = `${target}.${randomUUID()}.tmp`;
    try {
      writeSecretFile(staged, contents);
      fs.renameSync(staged, target);
    } catch (error) {
      try {
        fs.rmSync(staged, { force: true });
      } catch {
        // Keep the original failure.
      }
      throw error;
    }
  }
}

/** A form dotenv reads back unchanged, or `undefined` when no form does. */
function encodeValue(key: string, value: string): string | undefined {
  const forms = [`'${value}'`, `"${value}"`, `\`${value}\``];
  const candidates = /^['"`]/.test(value) ? forms : [value, ...forms];
  return candidates.find(form => dotenv.parse(`${key}=${form}`)[key] === value);
}

export { SECRET_KEYS };
