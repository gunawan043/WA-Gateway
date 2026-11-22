import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { BASE_PATH, MOCK_ROUTES, startMockCore, type MockHandle } from './mock-server';
import {
  createSchemaTools,
  type ContractDoc,
  type OperationObject,
  type ResponseObject,
  type SchemaObject,
} from './schema-validator';

/**
 * Uji kontrak Tahap 0.
 *
 * Tiga hal yang dijaga di sini:
 *
 * 1. Dokumen OpenAPI tetap jujur — setiap operasi bertanda provisional dan menyebut apa yang masih
 *    menunggu Core, tidak ada operasi tulis, dan seluruh `$ref` dapat diselesaikan.
 * 2. Fixture konsisten satu sama lain — setiap relasi menunjuk baris yang ada, snapshot sama dengan
 *    daftar, dan tidak ada field pribadi yang terlarang.
 * 3. Mock menyajikan bentuk yang sama dengan dokumen — responsnya divalidasi terhadap skema
 *    operasinya sendiri, sehingga mock dan kontrak tidak dapat menyimpang diam-diam.
 *
 * Uji ini tidak memanggil ALIM Core. Satu-satunya server yang hidup adalah mock di `mock-server.ts`.
 */

const contractPath = join(__dirname, 'connect-v1.openapi.yaml');
const doc = yaml.load(readFileSync(contractPath, 'utf8')) as ContractDoc;
const { schemas, expectValid } = createSchemaTools(doc);

const operations = (): Array<{ path: string; operation: OperationObject }> =>
  Object.entries(doc.paths ?? {}).flatMap(([path, item]) => {
    const operation = item.get;
    return operation === undefined ? [] : [{ path, operation }];
  });

const resolveResponse = (response: ResponseObject): ResponseObject => {
  if (response.$ref === undefined) return response;
  const name = response.$ref.replace('#/components/responses/', '');
  const resolved = doc.components?.responses?.[name];
  if (resolved === undefined) throw new Error(`Unresolved response $ref: ${response.$ref}`);
  return resolved;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as T;

interface Identified {
  id: string;
  updated_at: string;
}

interface UnitRow extends Identified {
  parent_id: string | null;
}

interface SchoolRow extends Identified {
  work_unit_id: string;
}

interface PlacementRow extends Identified {
  user_id: string;
  work_unit_id: string;
}

interface StructuralRow extends Identified {
  user_id: string;
  position_id: string;
  school_id: string | null;
  work_unit_id: string | null;
}

interface AdditionalRow extends Identified {
  source: string;
  user_id: string;
  unit_id: string | null;
  school_id: string | null;
}

interface SnapshotFixture {
  snapshot_at: string;
  counts: Record<string, number>;
  units: UnitRow[];
  schools: SchoolRow[];
  positions: Identified[];
  people: Identified[];
  work_unit_assignments: PlacementRow[];
  structural_assignments: StructuralRow[];
  additional_tasks: AdditionalRow[];
}

const units = readJson<UnitRow[]>('entities/units.json');
const schools = readJson<SchoolRow[]>('entities/schools.json');
const positions = readJson<Identified[]>('entities/positions.json');
const people = readJson<Identified[]>('entities/people.json');
const placements = readJson<PlacementRow[]>('entities/work-unit-assignments.json');
const structural = readJson<StructuralRow[]>('entities/structural-assignments.json');
const additional = readJson<AdditionalRow[]>('entities/additional-tasks.json');
const snapshot = readJson<SnapshotFixture>('snapshot.json');
const changes =
  readJson<Array<{ entity: string; action: string; id: string; deleted_at: string | null; payload: unknown }>>(
    'changes.json',
  );

const ENTITY_FILES: Array<{ file: string; schema: string }> = [
  { file: 'units.json', schema: 'Unit' },
  { file: 'schools.json', schema: 'School' },
  { file: 'positions.json', schema: 'Position' },
  { file: 'people.json', schema: 'Person' },
  { file: 'work-unit-assignments.json', schema: 'WorkUnitAssignment' },
  { file: 'structural-assignments.json', schema: 'StructuralAssignment' },
  { file: 'additional-tasks.json', schema: 'AdditionalTask' },
];

const CHANGE_SCHEMAS: Record<string, string> = {
  unit: 'Unit',
  school: 'School',
  position: 'Position',
  person: 'Person',
  work_unit_assignment: 'WorkUnitAssignment',
  structural_assignment: 'StructuralAssignment',
  additional_task: 'AdditionalTask',
};

const collectKeys = (value: unknown, keys: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
};

const collectRefs = (value: unknown, refs: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof child === 'string') refs.push(child);
      else collectRefs(child, refs);
    }
  }
  return refs;
};

describe('kontrak: dokumen', () => {
  it('menyatakan dirinya sebagai draf OpenAPI 3.1', () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info?.version).toContain('draft');
    expect(doc.info?.['x-contract-status']).toBe('provisional');
  });

  it('memuat tepat empat belas operasi baca dan tidak ada operasi tulis', () => {
    const ops = operations();
    expect(ops).toHaveLength(14);
    expect(ops.map(entry => entry.path).sort()).toEqual([...MOCK_ROUTES].sort());
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      const methods = Object.keys(item).filter(key => key !== 'summary' && key !== 'description');
      expect({ path, methods }).toEqual({ path, methods: ['get'] });
    }
  });

  it('menandai setiap operasi provisional dan menyebut apa yang menunggu Core', () => {
    for (const { path, operation } of operations()) {
      expect({ path, status: operation['x-contract-status'] }).toEqual({ path, status: 'provisional' });
      const pending = operation['x-needs-core-confirmation'];
      expect(Array.isArray(pending)).toBe(true);
      const items = pending as unknown[];
      expect({ path, count: items.length > 0 }).toEqual({ path, count: true });
      for (const item of items) {
        expect(typeof item).toBe('string');
        expect((item as string).trim().length).toBeGreaterThan(0);
      }
      expect(typeof operation.operationId).toBe('string');
    }
  });

  it('memberi setiap operasi operationId yang unik', () => {
    const ids = operations().map(entry => entry.operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mendeklarasikan autentikasi, versi, dan error yang sama di setiap operasi', () => {
    for (const { path, operation } of operations()) {
      const responses = operation.responses ?? {};
      for (const status of ['200', '401', '403', '429', '503']) {
        expect({ path, status, present: responses[status] !== undefined }).toEqual({ path, status, present: true });
      }
      const ok = resolveResponse(responses['200']);
      const headers = Object.keys(ok.headers ?? {});
      for (const header of ['X-ALIM-API-Version', 'X-Request-Id', 'Cache-Control']) {
        expect({ path, header, present: headers.includes(header) }).toEqual({ path, header, present: true });
      }
    }
  });

  it('hanya memakai GET dan tidak pernah menulis', () => {
    const text = readFileSync(contractPath, 'utf8');
    for (const method of ['post:', 'put:', 'patch:', 'delete:']) {
      expect(text).not.toMatch(new RegExp(`^\\s{4}${method}`, 'm'));
    }
  });

  it('menyelesaikan setiap $ref', () => {
    const refs = [...new Set(collectRefs(doc))];
    expect(refs.length).toBeGreaterThan(10);
    const unresolved = refs.filter(ref => {
      const [group, name] = ref.replace('#/components/', '').split('/');
      const bucket = (doc.components as Record<string, Record<string, unknown> | undefined>)[group];
      return bucket?.[name] === undefined;
    });
    expect(unresolved).toEqual([]);
  });
});

describe('kontrak: fixture', () => {
  it.each(ENTITY_FILES)('$file mematuhi skema $schema', ({ file, schema }) => {
    const rows = readJson<unknown[]>(`entities/${file}`);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row, index) => expectValid(row, schemas[schema], `${file}[${index}]`));
  });

  it('snapshot dan changes mematuhi skemanya', () => {
    expectValid(snapshot, schemas['Snapshot'], 'snapshot');
    changes.forEach((change, index) => expectValid(change, schemas['Change'], `changes[${index}]`));
  });

  it('menerima anomali yang memang ada di Core tanpa mengklaim data bersih', () => {
    const orphan = readJson<unknown[]>('edge/orphan-unit.json');
    const cycle = readJson<unknown[]>('edge/cycle-units.json');
    const deleted = readJson<unknown[]>('edge/deleted-structural-assignment.json');
    orphan.forEach((row, index) => expectValid(row, schemas['Unit'], `orphan[${index}]`));
    cycle.forEach((row, index) => expectValid(row, schemas['Unit'], `cycle[${index}]`));
    deleted.forEach((row, index) => expectValid(row, schemas['StructuralAssignment'], `deleted[${index}]`));
    // Anomali ini sengaja tidak lolos pemeriksaan relasi di bawah.
    const unitIds = new Set(units.map(unit => unit.id));
    expect(orphan.every(row => !unitIds.has((row as UnitRow).parent_id ?? ''))).toBe(true);
  });

  it('tidak mengulang id dalam satu entitas', () => {
    for (const rows of [units, schools, positions, people, placements, structural, additional]) {
      const ids = rows.map(row => row.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('memakai (source, id) sebagai kunci tugas tambahan', () => {
    const keys = additional.map(row => `${row.source}:${row.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(additional.map(row => row.source))).toEqual(
      new Set(['gtk_additional_tasks', 'other_teacher_tasks']),
    );
  });

  it('menutup setiap relasi ke baris yang ada', () => {
    const unitIds = new Set(units.map(row => row.id));
    const schoolIds = new Set(schools.map(row => row.id));
    const personIds = new Set(people.map(row => row.id));
    const positionIds = new Set(positions.map(row => row.id));

    expect(units.filter(row => row.parent_id !== null && !unitIds.has(row.parent_id))).toEqual([]);
    expect(schools.filter(row => !unitIds.has(row.work_unit_id))).toEqual([]);
    expect(placements.filter(row => !personIds.has(row.user_id))).toEqual([]);
    expect(placements.filter(row => !unitIds.has(row.work_unit_id))).toEqual([]);
    expect(structural.filter(row => !personIds.has(row.user_id))).toEqual([]);
    expect(structural.filter(row => !positionIds.has(row.position_id))).toEqual([]);
    expect(structural.filter(row => row.school_id !== null && !schoolIds.has(row.school_id))).toEqual([]);
    expect(structural.filter(row => row.work_unit_id !== null && !unitIds.has(row.work_unit_id))).toEqual([]);
    expect(additional.filter(row => !personIds.has(row.user_id))).toEqual([]);
    expect(additional.filter(row => row.unit_id !== null && !unitIds.has(row.unit_id))).toEqual([]);
    expect(additional.filter(row => row.school_id !== null && !schoolIds.has(row.school_id))).toEqual([]);
  });

  it('menjaga snapshot sama dengan daftar per entitas', () => {
    expect(snapshot.units).toEqual(units);
    expect(snapshot.schools).toEqual(schools);
    expect(snapshot.positions).toEqual(positions);
    expect(snapshot.people).toEqual(people);
    expect(snapshot.work_unit_assignments).toEqual(placements);
    expect(snapshot.structural_assignments).toEqual(structural);
    expect(snapshot.additional_tasks).toEqual(additional);
    for (const [key, count] of Object.entries(snapshot.counts)) {
      const rows = (snapshot as unknown as Record<string, unknown[]>)[key];
      expect({ key, count, actual: rows.length }).toEqual({ key, count, actual: count });
    }
  });

  it('tidak menyertakan baris yang lebih baru dari snapshot_at', () => {
    const bound = Date.parse(snapshot.snapshot_at);
    const rows = [
      ...snapshot.units,
      ...snapshot.schools,
      ...snapshot.positions,
      ...snapshot.people,
      ...snapshot.work_unit_assignments,
      ...snapshot.structural_assignments,
      ...snapshot.additional_tasks,
    ];
    expect(rows.filter(row => Date.parse(row.updated_at) > bound)).toEqual([]);
  });

  it('menjelaskan setiap perubahan terhadap baris yang dikenal', () => {
    for (const change of changes) {
      if (change.action === 'delete') {
        expect(change.payload).toBeNull();
        expect(change.deleted_at).not.toBeNull();
        continue;
      }
      expect(change.payload).not.toBeNull();
      expectValid(change.payload, schemas[CHANGE_SCHEMAS[change.entity]], `changes.${change.entity}`);
      const ids = new Set(
        [...units, ...schools, ...positions, ...people, ...placements, ...structural, ...additional].map(row => row.id),
      );
      expect(ids.has(change.id)).toBe(true);
    }
  });

  it('tidak membawa field pribadi di luar matriks 35a §8.3', () => {
    const forbidden = [
      'nik',
      'no_kk',
      'alamat',
      'nomor_sk',
      'tanggal_lahir',
      'tempat_lahir',
      'npwp',
      'nama_ibu',
      'nama_ayah',
      'nomor_rekening',
    ];
    const keys = new Set(
      [
        ...ENTITY_FILES.map(({ file }) => readJson<unknown>(`entities/${file}`)),
        readJson<unknown>('snapshot.json'),
        readJson<unknown>('changes.json'),
      ].flatMap(value => collectKeys(value)),
    );
    expect([...forbidden].filter(key => keys.has(key))).toEqual([]);
  });
});

describe('kontrak: mock', () => {
  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMockCore({ apiKey: 'contract-test-key' });
  });

  afterAll(async () => {
    await mock.close();
  });

  const get = async (path: string, key = 'contract-test-key'): Promise<Response> =>
    fetch(`${mock.url}${path}`, { headers: { 'X-ALIM-CONNECT-KEY': key } });

  const concretePath = (template: string): string => {
    const ids: Record<string, string> = {
      '/organization/units/{id}': `/organization/units/${units[0].id}`,
      '/organization/schools/{id}': `/organization/schools/${schools[0].id}`,
      '/organization/positions/{id}': `/organization/positions/${positions[0].id}`,
      '/organization/people/{id}': `/organization/people/${people[0].id}`,
      '/organization/people/{id}/assignments': `/organization/people/${people[0].id}/assignments`,
    };
    return ids[template] ?? template;
  };

  it.each([...MOCK_ROUTES])('menyajikan %s sesuai skema operasinya', async template => {
    const suffix = template === '/organization/changes' ? '?since=2026-01-01T00:00:00Z' : '';
    const response = await get(`${concretePath(template)}${suffix}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(response.headers.get('x-alim-api-version')).toBe('1');
    expect(response.headers.get('x-request-id')).toMatch(UUID);

    const body = (await response.json()) as Record<string, unknown>;
    const operation = doc.paths?.[template]?.get;
    const schema = operation?.responses?.['200']?.content?.['application/json']?.schema;
    expect(schema).toBeDefined();
    expectValid(body, schema as SchemaObject, `GET ${template}`);
    expect(body['success']).toBe(true);
  });

  it('membatasi halaman dan melaporkan pagination', async () => {
    const response = await get('/organization/units?per_page=1&page=2');
    const body = (await response.json()) as { data: unknown[]; meta: { pagination: Record<string, number> } };
    expect(body.data).toHaveLength(1);
    expect(body.meta.pagination).toEqual({ page: 2, per_page: 1, total: 3, last_page: 3 });
  });

  it('menghormati filter yang dipakai Connect', async () => {
    const children = (await (await get(`/organization/units?parent_id=${units[0].id}`)).json()) as {
      data: unknown[];
    };
    expect(children.data).toHaveLength(2);

    const inactive = (await (await get('/organization/units?is_active=false')).json()) as {
      meta: { pagination: { total: number } };
    };
    expect(inactive.meta.pagination.total).toBe(0);

    const bySource = (await (await get('/organization/additional-tasks?source=gtk_additional_tasks')).json()) as {
      data: Array<{ source: string }>;
    };
    expect(bySource.data).toHaveLength(1);
    expect(bySource.data[0].source).toBe('gtk_additional_tasks');
  });

  it('mengembalikan 404 untuk entitas yang tidak ada', async () => {
    const response = await get('/organization/units/00000000-0000-4000-8000-000000000000');
    expect(response.status).toBe(404);
    expectValid(await response.json(), schemas['ErrorEnvelope'], '404');
  });

  it('menolak changes tanpa since dengan 422', async () => {
    const response = await get('/organization/changes');
    expect(response.status).toBe(422);
    const body = (await response.json()) as { success: boolean; errors: unknown };
    expect(body.success).toBe(false);
    expect(body.errors).not.toBeNull();
  });

  it('menolak kunci yang salah dan tidak memberi petunjuk isi kunci', async () => {
    const response = await get('/organization/units', 'wrong-key');
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain('contract-test-key');

    // Draf hanya memaku header; alternatif `Bearer` belum disepakati (K9), jadi mock menolaknya.
    const bearer = await fetch(`${mock.url}/organization/units`, {
      headers: { Authorization: 'Bearer contract-test-key' },
    });
    expect(bearer.status).toBe(401);
  });

  it('menolak metode tulis dengan 405', async () => {
    const response = await fetch(`${mock.url}/organization/units`, {
      method: 'POST',
      headers: { 'X-ALIM-CONNECT-KEY': 'contract-test-key' },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('mematuhi kill switch tanpa deploy', async () => {
    const disabled = await startMockCore({ apiKey: 'contract-test-key', enabled: false });
    try {
      const response = await fetch(`${disabled.url}/organization/units`, {
        headers: { 'X-ALIM-CONNECT-KEY': 'contract-test-key' },
      });
      expect(response.status).toBe(503);
    } finally {
      await disabled.close();
    }
  });

  it('membatasi trafik sah, bukan hanya autentikasi gagal', async () => {
    const limited = await startMockCore({
      apiKey: 'contract-test-key',
      rateLimit: { limit: 2, windowMs: 60_000 },
    });
    try {
      const call = (): Promise<Response> =>
        fetch(`${limited.url}/organization/units`, { headers: { 'X-ALIM-CONNECT-KEY': 'contract-test-key' } });
      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(200);
      const third = await call();
      expect(third.status).toBe(429);
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });

  it('memakai prefix path yang sama dengan kontrak', () => {
    expect(mock.url.endsWith(BASE_PATH)).toBe(true);
  });
});

describe('paket Tahap 0: kelengkapan dokumen', () => {
  const readDoc = (): string =>
    readFileSync(join(__dirname, '..', '..', '..', 'docs', '35c-alim-core-connect-api-contract-draft.md'), 'utf8');

  it('mencatat K1–K10, Q1–Q10, dan S1–S8', () => {
    const text = readDoc();
    for (let index = 1; index <= 10; index += 1) {
      expect(text).toContain(`| K${index}`);
      expect(text).toContain(`| Q${index}`);
    }
    for (let index = 1; index <= 8; index += 1) {
      expect(text).toContain(`| S${index}`);
    }
  });

  it('memuat tiga bagian laporan yang diminta', () => {
    const text = readDoc();
    expect(text).toContain('## 9. Bagian yang sudah konsisten');
    expect(text).toContain('## 10. Bagian yang masih provisional');
    expect(text).toContain('## 11. Keputusan yang membutuhkan persetujuan pemilik sistem');
  });

  it('menyebut dirinya bukan kontrak final', () => {
    const text = readDoc();
    expect(text).toMatch(/bukan kontrak final/i);
    expect(text).toMatch(/provisional/i);
  });

  it('mencantumkan artefak yang benar-benar ada', () => {
    const text = readDoc();
    for (const name of ['connect-v1.openapi.yaml', 'mock-server.ts', 'contract.spec.ts', 'fixtures/']) {
      expect(text).toContain(name);
    }
    expect(readdirSync(join(__dirname, 'fixtures', 'entities'))).toHaveLength(ENTITY_FILES.length);
  });
});
