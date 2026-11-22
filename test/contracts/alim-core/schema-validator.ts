/**
 * Validator kecil untuk subset JSON Schema yang dipakai kontrak ALIM Core.
 *
 * Dipakai bersama oleh kontrak master read-only (`contract.spec.ts`) dan kontrak
 * Approval Command (`approval-command.spec.ts`) supaya kedua dokumen tidak
 * divalidasi dengan aturan yang berbeda diam-diam.
 *
 * Tidak ada dependensi runtime: cukup untuk membuktikan fixture dan respons mock
 * mematuhi skemanya sendiri.
 */

export interface SchemaObject {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  additionalProperties?: boolean | SchemaObject;
  format?: string;
  allOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
}

export interface ResponseObject {
  $ref?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, { schema?: SchemaObject }>;
}

export interface OperationObject {
  operationId?: string;
  'x-contract-status'?: string;
  'x-needs-core-confirmation'?: unknown;
  responses?: Record<string, ResponseObject>;
}

export interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  [method: string]: unknown;
}

export interface ContractDoc {
  openapi?: string;
  info?: { version?: string; 'x-contract-status'?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    responses?: Record<string, ResponseObject>;
    parameters?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const typeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};

const sameValue = (left: unknown, right: unknown): boolean =>
  typeof left === 'object' || typeof right === 'object'
    ? JSON.stringify(left) === JSON.stringify(right)
    : left === right;

export const createSchemaTools = (doc: ContractDoc) => {
  const schemas = doc.components?.schemas ?? {};

  const resolveSchema = (ref: string): SchemaObject => {
    const name = ref.replace('#/components/schemas/', '');
    const schema = schemas[name];
    if (schema === undefined) throw new Error(`Unresolved schema $ref: ${ref}`);
    return schema;
  };

  function validate(value: unknown, schema: SchemaObject, at: string, errors: string[]): void {
    if (schema.$ref !== undefined) {
      validate(value, resolveSchema(schema.$ref), at, errors);
      return;
    }

    if (schema.allOf !== undefined) {
      for (const part of schema.allOf) validate(value, part, at, errors);
    }

    if (schema.anyOf !== undefined) {
      const attempts = schema.anyOf.map(part => {
        const attempt: string[] = [];
        validate(value, part, at, attempt);
        return attempt;
      });
      if (!attempts.some(attempt => attempt.length === 0)) {
        errors.push(`${at}: does not match any allowed shape`);
        return;
      }
    }

    if (schema.const !== undefined && !sameValue(value, schema.const)) {
      errors.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
      return;
    }

    if (schema.enum !== undefined && !schema.enum.some(candidate => sameValue(value, candidate))) {
      errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
      return;
    }

    const declared = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (declared !== null && !declared.includes(actual)) {
      errors.push(`${at}: expected ${declared.join('|')}, got ${actual}`);
      return;
    }

    if (actual === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) errors.push(`${at}: missing required property "${key}"`);
      }
      for (const [key, child] of Object.entries(record)) {
        const declaredChild = schema.properties?.[key];
        if (declaredChild !== undefined) {
          validate(child, declaredChild, `${at}.${key}`, errors);
        } else if (schema.additionalProperties === false) {
          errors.push(`${at}: unexpected property "${key}"`);
        } else if (typeof schema.additionalProperties === 'object') {
          validate(child, schema.additionalProperties, `${at}.${key}`, errors);
        }
      }
    }

    if (actual === 'array') {
      const items = value as unknown[];
      if (schema.minItems !== undefined && items.length < schema.minItems) {
        errors.push(`${at}: expected at least ${schema.minItems} items, got ${items.length}`);
      }
      if (schema.items !== undefined) {
        items.forEach((item, index) => validate(item, schema.items as SchemaObject, `${at}[${index}]`, errors));
      }
    }

    if (actual === 'string') {
      const text = value as string;
      if (schema.format === 'uuid' && !UUID.test(text)) errors.push(`${at}: "${text}" is not a UUID`);
      if (schema.format === 'date-time' && !DATE_TIME.test(text))
        errors.push(`${at}: "${text}" is not an ISO date-time`);
      if (schema.format === 'date' && !DATE.test(text)) errors.push(`${at}: "${text}" is not an ISO date`);
      if (schema.minLength !== undefined && text.length < schema.minLength) {
        errors.push(`${at}: shorter than ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && text.length > schema.maxLength) {
        errors.push(`${at}: longer than ${schema.maxLength}`);
      }
    }

    if (actual === 'integer' || actual === 'number') {
      const numeric = value as number;
      if (schema.minimum !== undefined && numeric < schema.minimum)
        errors.push(`${at}: ${numeric} < ${schema.minimum}`);
      if (schema.maximum !== undefined && numeric > schema.maximum)
        errors.push(`${at}: ${numeric} > ${schema.maximum}`);
    }
  }

  const expectValid = (value: unknown, schema: SchemaObject, at: string): void => {
    const errors: string[] = [];
    validate(value, schema, at, errors);
    expect(errors).toEqual([]);
  };

  return { schemas, resolveSchema, validate, expectValid };
};
