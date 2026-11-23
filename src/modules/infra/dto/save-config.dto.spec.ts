import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SaveConfigDto } from './save-config.dto';

// Mirrors the real pipe: whitelist + forbidNonWhitelisted, and the enableImplicitConversion
// transform option from src/config/app-validation.ts. A form-encoded (urlencoded) body delivers
// every scalar as a string; without the strict transforms the implicit cast turns ANY non-empty
// string — including 'false' — into `true`, so an unchecked Infrastructure toggle would persist
// 'true' into data/.env.generated and be applied on the next boot.
const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };
const PIPE_VALIDATOR_OPTS = { whitelist: true, forbidNonWhitelisted: true };

async function run(payload: unknown) {
  const instance = plainToInstance(SaveConfigDto, payload as object, PIPE_TRANSFORM_OPTS);
  const errors = await validate(instance, PIPE_VALIDATOR_OPTS);
  return { instance, errors };
}

// Every boolean field on the save-config DTO, with the section keys its parent requires.
const BOOLEAN_FIELDS: Array<{ section: 'database' | 'redis' | 'queue' | 'storage' | 'engine'; field: string }> = [
  { section: 'database', field: 'builtIn' },
  { section: 'database', field: 'sslEnabled' },
  { section: 'database', field: 'sslRejectUnauthorized' },
  { section: 'redis', field: 'enabled' },
  { section: 'redis', field: 'builtIn' },
  { section: 'queue', field: 'enabled' },
  { section: 'storage', field: 'builtIn' },
  { section: 'engine', field: 'headless' },
];

const SECTION_BASE: Record<string, Record<string, unknown>> = {
  database: { type: 'postgres' },
  redis: {},
  queue: {},
  storage: { type: 'local' },
  engine: {},
};

describe('SaveConfigDto strict coercion', () => {
  it.each(BOOLEAN_FIELDS.map(f => [`${f.section}.${f.field}`, f] as const))(
    "%s maps a form-encoded 'false' to a real false",
    async (_label, { section, field }) => {
      const { instance, errors } = await run({ [section]: { ...SECTION_BASE[section], [field]: 'false' } });
      expect(errors).toHaveLength(0);
      const sectionValue = instance[section] as unknown as Record<string, unknown>;
      expect(sectionValue[field]).toBe(false);
    },
  );

  it.each(BOOLEAN_FIELDS.map(f => [`${f.section}.${f.field}`, f] as const))(
    "%s maps a form-encoded 'true' to a real true",
    async (_label, { section, field }) => {
      const { instance, errors } = await run({ [section]: { ...SECTION_BASE[section], [field]: 'true' } });
      expect(errors).toHaveLength(0);
      const sectionValue = instance[section] as unknown as Record<string, unknown>;
      expect(sectionValue[field]).toBe(true);
    },
  );

  it.each(
    BOOLEAN_FIELDS.flatMap(f =>
      ['yes', '0'].map(spelling => [`${f.section}.${f.field} (${JSON.stringify(spelling)})`, f, spelling] as const),
    ),
  )('%s is rejected instead of being guessed', async (_label, { section, field }, spelling) => {
    const { errors } = await run({ [section]: { ...SECTION_BASE[section], [field]: spelling } });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts real booleans untouched', async () => {
    const { instance, errors } = await run({
      queue: { enabled: false },
      engine: { headless: true },
    });
    expect(errors).toHaveLength(0);
    expect(instance.queue?.enabled).toBe(false);
    expect(instance.engine?.headless).toBe(true);
  });

  it("rejects a blank poolSize (Number('') is 0 — a real value the caller never sent)", async () => {
    const { errors } = await run({ database: { type: 'postgres', poolSize: '' } });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('maps a numeric poolSize string to a number', async () => {
    const { instance, errors } = await run({ database: { type: 'postgres', poolSize: '25' } });
    expect(errors).toHaveLength(0);
    expect(instance.database?.poolSize).toBe(25);
  });
});

// @ValidateNested checks an array element by element, so a section sent as [] or [{...}] passed validation.
describe('SaveConfigDto sections refuse an array', () => {
  const SECTIONS = Object.keys(SECTION_BASE);

  it.each(SECTIONS)('%s as an object is accepted', async section => {
    const { errors } = await run({ [section]: SECTION_BASE[section] });
    expect(errors).toHaveLength(0);
  });

  it.each(SECTIONS.flatMap(section => [[section, []] as const, [section, [SECTION_BASE[section]]] as const]))(
    '%s as an array (%j) is refused',
    async (section, value) => {
      const { errors } = await run({ [section]: value });
      expect(errors.map(e => e.property)).toEqual([section]);
    },
  );
});

// A section without its type keeps the stored selection (applyDatabaseSection, applyStorageSection), so the page can
// leave out a type the environment pins. A type that is sent is still held to the enum.
describe('SaveConfigDto section types', () => {
  it.each(['database', 'storage'])('%s may leave its type out', async section => {
    const { errors } = await run({ [section]: { builtIn: false } });
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['database', 'mysql'],
    ['storage', 'ftp'],
  ])('%s refuses a type outside the enum (%s)', async (section, type) => {
    const { errors } = await run({ [section]: { type } });
    expect(errors.map(e => e.property)).toEqual([section]);
  });
});

/**
 * Every nested section is declared as a lazy `type: () => Dto` thunk so Swagger can build the schema
 * without a circular import. The thunk only runs when a schema is generated, which this suite never
 * does — so a thunk pointing at the wrong class, or resolving to `undefined` through a cycle, would
 * first surface in the OpenAPI export. Resolving each one here pins the mapping in the fast lane.
 */
describe('SaveConfigDto nested schema types', () => {
  const METADATA = 'swagger/apiModelProperties';
  const propertyNames = (
    Reflect.getOwnMetadata('swagger/apiModelPropertiesArray', SaveConfigDto.prototype) as string[]
  ).map(name => name.replace(/^:/, ''));

  const expected: Record<string, string> = {
    database: 'DatabaseConfigDto',
    redis: 'RedisConfigDto',
    queue: 'QueueConfigDto',
    storage: 'StorageConfigDto',
    engine: 'EngineConfigDto',
  };

  it('declares exactly the five nested sections', () => {
    expect([...propertyNames].sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s resolves to %s', (property, className) => {
    const meta = Reflect.getOwnMetadata(METADATA, SaveConfigDto.prototype, property) as {
      type?: unknown;
      required?: boolean;
    };

    expect(meta).toBeDefined();
    expect(typeof meta.type).toBe('function');

    const resolved = (meta.type as () => unknown)() as { name?: string };
    expect(resolved).toBeDefined();
    expect(resolved.name).toBe(className);
    // Every section is optional: a save may change one without resending the others.
    expect(meta.required).toBe(false);
  });
});
