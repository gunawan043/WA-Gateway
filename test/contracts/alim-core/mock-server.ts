import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Mock ALIM Core untuk Tahap 0.
 *
 * Server ini hanya membaca fixture di `fixtures/` dan tidak pernah membuka koneksi ke ALIM Core,
 * database, atau jaringan lain. Tujuannya satu: menyajikan bentuk yang sama dengan
 * `connect-v1.openapi.yaml` supaya kontrak dan mock tidak dapat berbeda diam-diam.
 *
 * Yang **tidak** dimodelkan: data produksi, otorisasi nyata, change ledger, dan perilaku
 * `updated_at` Core. Nilai `null`, `id` baris yang berubah, dan `parent_id` yatim hanya ada di
 * `fixtures/edge/` dan tidak disajikan oleh mock.
 */

export const BASE_PATH = '/api/connect/v1';

/** Setiap path template yang dilayani mock. Dipakai uji paritas terhadap OpenAPI. */
export const MOCK_ROUTES = [
  '/organization/units',
  '/organization/units/{id}',
  '/organization/schools',
  '/organization/schools/{id}',
  '/organization/positions',
  '/organization/positions/{id}',
  '/organization/people',
  '/organization/people/{id}',
  '/organization/people/{id}/assignments',
  '/organization/work-unit-assignments',
  '/organization/structural-assignments',
  '/organization/additional-tasks',
  '/organization/snapshot',
  '/organization/changes',
] as const;

export type MockRoute = (typeof MOCK_ROUTES)[number];

interface Identified {
  id: string;
}

interface UnitRow extends Identified {
  code: string;
  name: string;
  type: string;
  parent_id: string | null;
  is_active: boolean;
  updated_at: string;
}

interface SchoolRow extends Identified {
  work_unit_id: string;
  name: string;
  school_level: string;
  school_gender: string;
  is_active: boolean;
  updated_at: string;
}

interface PositionRow extends Identified {
  code: string;
  name: string;
  is_active: boolean;
  updated_at: string;
}

interface PersonRow extends Identified {
  name: string;
  username: string | null;
  email: string | null;
  is_active: boolean;
  updated_at: string;
}

interface PlacementRow extends Identified {
  user_id: string;
  work_unit_id: string;
  is_primary: boolean;
  updated_at: string;
}

interface StructuralRow extends Identified {
  user_id: string;
  status: string;
  deleted_at: string | null;
  updated_at: string;
}

interface AdditionalRow extends Identified {
  source: string;
  user_id: string;
  updated_at: string;
}

interface SnapshotFixture {
  generated_at: string;
  snapshot_at: string;
  schema_version: number;
  counts: Record<string, number>;
  checksums: Record<string, string>;
  units: UnitRow[];
  schools: SchoolRow[];
  positions: PositionRow[];
  people: PersonRow[];
  work_unit_assignments: PlacementRow[];
  structural_assignments: StructuralRow[];
  additional_tasks: AdditionalRow[];
}

interface ChangeRow {
  entity: string;
  action: string;
  id: string;
  source: string | null;
  updated_at: string;
  deleted_at: string | null;
  payload: Record<string, unknown> | null;
}

interface Fixtures {
  units: UnitRow[];
  schools: SchoolRow[];
  positions: PositionRow[];
  people: PersonRow[];
  placements: PlacementRow[];
  structural: StructuralRow[];
  additional: AdditionalRow[];
  snapshot: SnapshotFixture;
  changes: ChangeRow[];
}

/** Nama tipe pada `changes` ke nama kunci pada `snapshot`/`types`. */
const CHANGE_TYPES: Record<string, string> = {
  unit: 'units',
  school: 'schools',
  position: 'positions',
  person: 'people',
  work_unit_assignment: 'work_unit_assignments',
  structural_assignment: 'structural_assignments',
  additional_task: 'additional_tasks',
};

export interface MockOptions {
  /** Kunci yang diterima. Default `test-connect-key`. */
  apiKey?: string;
  /** Kill switch setara `IntegrationApiConfig::enabled`. Default `true`. */
  enabled?: boolean;
  /** Batas trafik per jendela. Default 600 permintaan per menit. */
  rateLimit?: { limit: number; windowMs: number };
  /** Port; `0` memilih port kosong. */
  port?: number;
}

export interface MockHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const read = <T>(name: string): T => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as T;

const loadFixtures = (): Fixtures => ({
  units: read<UnitRow[]>('entities/units.json'),
  schools: read<SchoolRow[]>('entities/schools.json'),
  positions: read<PositionRow[]>('entities/positions.json'),
  people: read<PersonRow[]>('entities/people.json'),
  placements: read<PlacementRow[]>('entities/work-unit-assignments.json'),
  structural: read<StructuralRow[]>('entities/structural-assignments.json'),
  additional: read<AdditionalRow[]>('entities/additional-tasks.json'),
  snapshot: read<SnapshotFixture>('snapshot.json'),
  changes: read<ChangeRow[]>('changes.json'),
});

interface Meta {
  request_id: string;
  timestamp: string;
  server_time: string;
  pagination?: { page: number; per_page: number; total: number; last_page: number };
  next_cursor?: string | null;
  has_more?: boolean;
}

const envelope = (data: unknown, meta: Meta): Record<string, unknown> => ({
  success: true,
  message: 'OK',
  data,
  meta,
  errors: null,
});

const errorEnvelope = (
  message: string,
  meta: Meta,
  errors: Record<string, unknown> | null = null,
): Record<string, unknown> => ({
  success: false,
  message,
  data: null,
  meta,
  errors,
});

const asArray = (value: string | null): string[] | null =>
  value === null
    ? null
    : value
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);

const paginate = <T>(rows: T[], url: URL): { page: T[]; meta: NonNullable<Meta['pagination']> } => {
  const rawPage = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(url.searchParams.get('per_page') ?? '50', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const perPage = Math.min(200, Math.max(1, Number.isFinite(rawPerPage) ? rawPerPage : 50));
  const start = (page - 1) * perPage;
  return {
    page: rows.slice(start, start + perPage),
    meta: {
      page,
      per_page: perPage,
      total: rows.length,
      last_page: rows.length === 0 ? 0 : Math.ceil(rows.length / perPage),
    },
  };
};

const activeFilter = <T extends { is_active: boolean }>(rows: T[], url: URL): T[] => {
  const value = url.searchParams.get('is_active') ?? 'true';
  if (value === 'all') return rows;
  const wanted = value !== 'false';
  return rows.filter(row => row.is_active === wanted);
};

const updatedSince = <T extends { updated_at: string }>(rows: T[], url: URL): T[] => {
  const since = url.searchParams.get('updated_since');
  if (since === null) return rows;
  const bound = Date.parse(since);
  if (Number.isNaN(bound)) return rows;
  return rows.filter(row => Date.parse(row.updated_at) >= bound);
};

const matches = (needle: string | null, ...haystack: Array<string | null>): boolean => {
  if (needle === null || needle.trim() === '') return true;
  const query = needle.trim().toLowerCase();
  return haystack.some(value => (value ?? '').toLowerCase().includes(query));
};

export async function startMockCore(options: MockOptions = {}): Promise<MockHandle> {
  const fixtures = loadFixtures();
  const apiKey = options.apiKey ?? 'test-connect-key';
  const enabled = options.enabled ?? true;
  const limit = options.rateLimit?.limit ?? 600;
  const windowMs = options.rateLimit?.windowMs ?? 60_000;

  let windowStart = Date.now();
  let used = 0;

  const consume = (): number | null => {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      used = 0;
    }
    used += 1;
    return used > limit ? Math.ceil((windowStart + windowMs - now) / 1000) : null;
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const requestId = randomUUID();
    const now = new Date().toISOString();
    const meta = (extra: Partial<Meta> = {}): Meta => ({
      request_id: requestId,
      timestamp: now,
      server_time: now,
      ...extra,
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-ALIM-API-Version', '1');
    res.setHeader('X-Request-Id', requestId);

    const send = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      send(405, errorEnvelope('Method not allowed. This API is read-only.', meta()));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(BASE_PATH)) {
      send(404, errorEnvelope('Unknown route.', meta()));
      return;
    }
    const path = url.pathname.slice(BASE_PATH.length) || '/';

    if (!enabled) {
      send(503, errorEnvelope('Connect integration is disabled.', meta()));
      return;
    }

    const headerKey = req.headers['x-alim-connect-key'];
    const presented = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    if (presented !== apiKey) {
      send(401, errorEnvelope('Invalid integration key.', meta()));
      return;
    }

    const retryAfter = consume();
    if (retryAfter !== null) {
      res.setHeader('Retry-After', String(retryAfter));
      send(429, errorEnvelope('Rate limit exceeded.', meta()));
      return;
    }

    /** Hanya dipanggil bila `path` sudah terbukti berada di bawah `prefix`. */
    const detail = (prefix: string, rows: Array<{ id: string }>): void => {
      const id = path === prefix ? '' : path.slice(prefix.length + 1);
      if (id === '' || id.includes('/')) {
        send(404, errorEnvelope('Unknown route.', meta()));
        return;
      }
      const row = rows.find(candidate => candidate.id === id);
      if (row === undefined) {
        send(404, errorEnvelope('Entity not found.', meta()));
        return;
      }
      send(200, envelope(row, meta()));
    };

    switch (path) {
      case '/organization/units': {
        const parentId = url.searchParams.get('parent_id');
        const type = url.searchParams.get('type');
        const q = url.searchParams.get('q');
        const rows = updatedSince(activeFilter(fixtures.units, url), url).filter(
          row =>
            (parentId === null || row.parent_id === parentId) &&
            (type === null || row.type === type) &&
            matches(q, row.name, row.code),
        );
        const paged = paginate(rows, url);
        send(200, envelope(paged.page, meta({ pagination: paged.meta })));
        return;
      }
      case '/organization/schools': {
        const workUnitId = url.searchParams.get('work_unit_id');
        const level = url.searchParams.get('school_level');
        const gender = url.searchParams.get('school_gender');
        const q = url.searchParams.get('q');
        const rows = updatedSince(activeFilter(fixtures.schools, url), url).filter(
          row =>
            (workUnitId === null || row.work_unit_id === workUnitId) &&
            (level === null || row.school_level === level) &&
            (gender === null || row.school_gender === gender) &&
            matches(q, row.name),
        );
        const paged = paginate(rows, url);
        send(200, envelope(paged.page, meta({ pagination: paged.meta })));
        return;
      }
      case '/organization/positions': {
        const q = url.searchParams.get('q');
        const rows = updatedSince(activeFilter(fixtures.positions, url), url).filter(row =>
          matches(q, row.name, row.code),
        );
        const paged = paginate(rows, url);
        send(200, envelope(paged.page, meta({ pagination: paged.meta })));
        return;
      }
      case '/organization/people': {
        const q = url.searchParams.get('q');
        const rows = updatedSince(activeFilter(fixtures.people, url), url).filter(row =>
          matches(q, row.name, row.username, row.email),
        );
        const paged = paginate(rows, url);
        send(200, envelope(paged.page, meta({ pagination: paged.meta })));
        return;
      }
      case '/organization/work-unit-assignments': {
        const userId = url.searchParams.get('user_id');
        const workUnitId = url.searchParams.get('work_unit_id');
        const primary = url.searchParams.get('is_primary');
        const rows = updatedSince(fixtures.placements, url).filter(
          row =>
            (userId === null || row.user_id === userId) &&
            (workUnitId === null || row.work_unit_id === workUnitId) &&
            (primary === null || String(row.is_primary) === primary),
        );
        const paged = paginate(rows, url);
        send(200, envelope(paged.page, meta({ pagination: paged.meta })));
        return;
      }
      case '/organization/structural-assignments': {
        const userId = url.searchParams.get('user_id');
        const status = url.searchParams.get('status') ?? 'all';
        const includeDeleted = url.searchParams.get('include_deleted') === 'true';
        const rows = updatedSince(fixtures.structural, url).filter(
          row =>
            (includeDeleted || row.deleted_at === null) &&
            (userId === null || row.user_id === userId) &&
            (status === 'all' || row.status === status),
        );
        const paged = paginate(rows, url);
        send(200, envelope(paged.page, meta({ pagination: paged.meta })));
        return;
      }
      case '/organization/additional-tasks': {
        const userId = url.searchParams.get('user_id');
        const source = url.searchParams.get('source') ?? 'all';
        const rows = updatedSince(fixtures.additional, url).filter(
          row => (userId === null || row.user_id === userId) && (source === 'all' || row.source === source),
        );
        const paged = paginate(rows, url);
        send(200, envelope(paged.page, meta({ pagination: paged.meta })));
        return;
      }
      case '/organization/snapshot': {
        const types = asArray(url.searchParams.get('types'));
        const snapshot: Record<string, unknown> = { ...fixtures.snapshot };
        if (types !== null) {
          for (const key of Object.keys(snapshot)) {
            if (!['generated_at', 'snapshot_at', 'schema_version'].includes(key) && !types.includes(key)) {
              delete snapshot[key];
            }
          }
          snapshot.counts = Object.fromEntries(
            Object.entries(fixtures.snapshot.counts).filter(([key]) => types.includes(key)),
          );
          snapshot.checksums = Object.fromEntries(
            Object.entries(fixtures.snapshot.checksums).filter(([key]) => types.includes(key)),
          );
        }
        send(200, envelope(snapshot, meta()));
        return;
      }
      case '/organization/changes': {
        const since = url.searchParams.get('since');
        if (since === null) {
          send(
            422,
            errorEnvelope('The `since` parameter is required; take a snapshot first.', meta(), {
              since: ['The since field is required.'],
            }),
          );
          return;
        }
        const bound = Date.parse(since);
        if (Number.isNaN(bound)) {
          send(
            422,
            errorEnvelope('The `since` parameter is not a valid timestamp.', meta(), {
              since: ['The since field must be an ISO-8601 date-time.'],
            }),
          );
          return;
        }
        const types = asArray(url.searchParams.get('types'));
        const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
        const limitValue = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
        const rows = fixtures.changes
          .filter(change => Date.parse(change.updated_at) > bound)
          .filter(change => types === null || types.includes(CHANGE_TYPES[change.entity] ?? change.entity))
          .slice(0, limitValue);
        send(200, envelope(rows, meta({ next_cursor: null, has_more: rows.length === limitValue })));
        return;
      }
      default:
        break;
    }

    if (path.startsWith('/organization/people/')) {
      const rest = path.slice('/organization/people/'.length);
      const [personId, suffix] = rest.split('/');
      const person = fixtures.people.find(row => row.id === personId);
      if (person === undefined) {
        send(404, errorEnvelope('Entity not found.', meta()));
        return;
      }
      if (suffix === 'assignments') {
        const derived = [
          ...fixtures.placements.filter(row => row.user_id === personId).map(row => ({ ...row, source: 'work_unit' })),
          ...fixtures.structural
            .filter(row => row.user_id === personId && row.deleted_at === null)
            .map(row => ({ ...row, source: 'structural' })),
          ...fixtures.additional
            .filter(row => row.user_id === personId)
            .map(row => ({ ...row, source: 'additional_task' })),
        ];
        const paged = paginate(derived, url);
        send(200, envelope(paged.page, meta({ pagination: paged.meta })));
        return;
      }
      if (suffix === undefined) {
        send(200, envelope(person, meta()));
        return;
      }
      send(404, errorEnvelope('Unknown route.', meta()));
      return;
    }

    const collections: Array<[string, Array<{ id: string }>]> = [
      ['/organization/units', fixtures.units],
      ['/organization/schools', fixtures.schools],
      ['/organization/positions', fixtures.positions],
    ];
    for (const [prefix, rows] of collections) {
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        detail(prefix, rows);
        return;
      }
    }

    send(404, errorEnvelope('Unknown route.', meta()));
  };

  const server: Server = createServer(handle);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Mock server did not bind to a TCP port.');
  }

  return {
    url: `http://127.0.0.1:${address.port}${BASE_PATH}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

if (require.main === module) {
  void startMockCore({ port: Number.parseInt(process.env.PORT ?? '0', 10) }).then(handle => {
    process.stdout.write(`Mock ALIM Core listening on ${handle.url}\n`);
  });
}
