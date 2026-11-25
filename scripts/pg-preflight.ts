/**
 * Read-only preflight for the ALIM Connect production data database.
 *
 * WHAT IT ANSWERS
 * ---------------
 * Before a release can be deployed, the database owner has to decide one of two things: is this
 * database a faithful build of the migration chain (so the ledger just needs recording), or does it
 * need to be rebuilt? That decision should rest on facts, not on the 33-table count.
 *
 * This script only SELECTs. It creates nothing, writes nothing, and needs no write privilege. Its
 * job is to produce the evidence the decision cites, in a form that can be pasted into the report.
 *
 * WHAT "OK" MEANS
 * ---------------
 * Every expected table from the entity metadata is present, the approval tables carry every column
 * and index the chain declares, the ledger state is reported as-is, and nothing in `public` carries
 * a feature that would make a rebuild surprising (policies, triggers, custom types).
 *
 * A `FAIL` line is not necessarily a blocker — it is a fact the DB owner needs. In particular an
 * empty ledger over a complete schema is the documented starting condition of this database, not a
 * fault; see §5 of docs/integration/alim-connect-production-deployment-cycle-1.md.
 *
 * Usage (values come from the environment, never from arguments, so no credential lands in shell
 * history):
 *
 *   set -a; . ./.env; set +a
 *   npx ts-node scripts/pg-preflight.ts
 *
 * Exit code: 0 when every check is OK or INFO, 1 when any check FAILed, 2 when the connection
 * itself failed.
 */
import { Client } from 'pg';

/** The data-connection tables this release's entities declare. */
const EXPECTED_TABLES = [
  'approval_commands',
  'approval_requests',
  'automation_rules',
  'baileys_stored_messages',
  'campaign_recipients',
  'campaign_segments',
  'campaigns',
  'chat_states',
  'conversation_mappings',
  'crm_deal_activities',
  'crm_deals',
  'crm_stages',
  'division_agents',
  'division_chat_states',
  'division_settings',
  'divisions',
  'inbox_conversations',
  'inbox_notes',
  'ingress_events',
  'integration_delivery_failures',
  'lid_mappings',
  'message_batches',
  'messages',
  'plugin_instances',
  'send_idempotency_keys',
  'sessions',
  'status_updates',
  'templates',
  'webhook_delivery_failures',
  'webhook_outbox_events',
  'webhooks',
  'whatsapp_identities',
];

/** Columns the approval migrations must have produced, per table. */
const EXPECTED_COLUMNS: Record<string, string[]> = {
  approval_commands: [
    'lastError',
    'lastAttemptAt',
    'nextAttemptAt',
    'coreResponseBody',
    'errorCode',
    'externalMessageId',
    'decision',
    'status',
    'attempts',
  ],
  approval_requests: [
    'coreRequestId',
    'reference',
    'targetIdentity',
    'targetCorePersonId',
    'notificationMessageId',
    'coreStatus',
    'lastCommandId',
  ],
  whatsapp_identities: ['externalIdentity', 'corePersonId', 'isVerified', 'isActive'],
};

/** Indexes the approval migrations must have produced. The two lookup ones came last. */
const EXPECTED_INDEXES: Record<string, string[]> = {
  approval_commands: [
    'UQ_approval_commands_command',
    'UQ_approval_commands_external_message',
    'IDX_approval_commands_request',
  ],
  approval_requests: [
    'UQ_approval_requests_core_request',
    'UQ_approval_requests_reference',
    'IDX_approval_requests_status',
    'IDX_approval_requests_target_status',
  ],
};

type Verdict = 'OK' | 'INFO' | 'FAIL';

interface Finding {
  verdict: Verdict;
  check: string;
  detail: string;
}

const findings: Finding[] = [];
const record = (verdict: Verdict, check: string, detail: string): void => {
  findings.push({ verdict, check, detail });
};

function connectionOptions(): Record<string, unknown> {
  const env = process.env;
  const missing = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USERNAME', 'DATABASE_NAME'].filter(key => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')}. Load them first: set -a; . ./.env; set +a`);
  }
  return {
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT),
    user: env.DATABASE_USERNAME,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    // TLS is reported below, not assumed: a managed database reached without it has its password
    // and every row readable on the path.
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 15_000,
  };
}

async function main(): Promise<number> {
  const client = new Client(connectionOptions());
  try {
    await client.connect();
  } catch (error) {
    process.stderr.write(`Connection failed: ${(error as Error).message}\n`);
    return 2;
  }

  const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await client.query(sql, params)).rows as T[];

  try {
    // `SHOW x` returns a single column NAMED x, so read it by key rather than destructuring a
    // positional shape: `{ version }` was undefined and made a healthy server look broken.
    const server = await rows<Record<string, string>>('SHOW server_version');
    record('INFO', 'server', `PostgreSQL ${server[0]?.server_version ?? 'unknown'}`);

    const [{ user }] = await rows<{ user: string }>('SELECT current_user AS user');
    record('INFO', 'role', `${user} (superuser=${(await rows<{ s: string }>("SELECT current_setting('is_superuser') AS s"))[0].s})`);

    // `TimeZone` is capitalised in SHOW's output.
    const tzRows = await rows<Record<string, string>>('SHOW timezone');
    const tz = tzRows[0]?.TimeZone ?? tzRows[0]?.timezone ?? 'unknown';
    record(/^UTC$/i.test(tz) ? 'OK' : 'FAIL', 'timezone', `${tz} (the data connection asserts UTC at boot)`);

    // pg_stat_ssl reports `ssl` for THIS backend. It is false for a loopback/socket connection that
    // asked for TLS and got plaintext, and also for a local socket. Report the setting separately so
    // "TLS requested but not negotiated" cannot hide behind "TLS requested".
    const [{ ssl }] = await rows<{ ssl: boolean }>(
      'SELECT coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl',
    );
    const requested = process.env.DATABASE_SSL === 'true';
    record(
      ssl ? 'OK' : requested ? 'FAIL' : 'INFO',
      'tls',
      ssl
        ? `negotiated (certificate verified: ${process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'})`
        : requested
          ? 'DATABASE_SSL=true but the backend reports plaintext'
          : 'DATABASE_SSL is not true',
    );

    // Tables
    const tables = (
      await rows<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
      )
    ).map(r => r.table_name);
    const missingTables = EXPECTED_TABLES.filter(name => !tables.includes(name));
    record(
      missingTables.length === 0 ? 'OK' : 'FAIL',
      'tables',
      missingTables.length === 0
        ? `all ${EXPECTED_TABLES.length} expected tables present (${tables.length} in public)`
        : `missing: ${missingTables.join(', ')}`,
    );

    // Ledger
    const ledgerTable = await rows<{ x: boolean }>("SELECT to_regclass('public.migrations') IS NOT NULL AS x");
    if (!ledgerTable[0]?.x) {
      record('FAIL', 'migration ledger', 'public.migrations does not exist');
    } else {
      const [{ n }] = await rows<{ n: number }>('SELECT count(*)::int AS n FROM public.migrations');
      record(
        n === 0 ? 'INFO' : 'OK',
        'migration ledger',
        n === 0
          ? 'empty: the schema was built outside the migration path (see deployment report §5)'
          : `${n} rows recorded`,
      );
    }

    // Approval columns and indexes
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const present = (
        await rows<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
          [table],
        )
      ).map(r => r.column_name);
      const missing = columns.filter(name => !present.includes(name));
      record(missing.length === 0 ? 'OK' : 'FAIL', `${table} columns`, missing.length === 0 ? `${present.length} columns` : `missing ${missing.join(', ')}`);
    }

    for (const [table, indexes] of Object.entries(EXPECTED_INDEXES)) {
      const present = (
        await rows<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1",
          [table],
        )
      ).map(r => r.indexname);
      const missing = indexes.filter(name => !present.includes(name));
      record(missing.length === 0 ? 'OK' : 'FAIL', `${table} indexes`, missing.length === 0 ? `${present.length} indexes` : `missing ${missing.join(', ')}`);
    }

    // Features a rebuild would silently drop
    const [{ policies }] = await rows<{ policies: number }>(
      "SELECT count(*)::int AS policies FROM pg_policies WHERE schemaname='public'",
    );
    record(policies === 0 ? 'OK' : 'INFO', 'row-level security', policies === 0 ? 'none' : `${policies} policies exist`);

    const [{ triggers }] = await rows<{ triggers: number }>(
      "SELECT count(*)::int AS triggers FROM information_schema.triggers WHERE trigger_schema='public'",
    );
    record(triggers === 0 ? 'OK' : 'INFO', 'triggers', triggers === 0 ? 'none' : `${triggers} triggers exist`);

    const [{ enums }] = await rows<{ enums: number }>(
      "SELECT count(*)::int AS enums FROM pg_type t JOIN pg_namespace ns ON ns.oid=t.typnamespace WHERE ns.nspname='public' AND t.typtype='e'",
    );
    record(enums === 0 ? 'OK' : 'INFO', 'custom enum types', String(enums));

    // Data volume: a rebuild is cheap only if there is little to carry
    const counts = await rows<{ relname: string; n_live_tup: number }>(
      "SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY n_live_tup DESC LIMIT 5",
    );
    record('INFO', 'largest tables', counts.map(r => `${r.relname}=${r.n_live_tup}`).join(' ') || 'none');

    // Supabase service schemas are a note for the DB owner, not a fault
    const schemas = (
      await rows<{ schema_name: string }>(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' ORDER BY 1",
      )
    ).map(r => r.schema_name);
    const foreign = schemas.filter(s => s !== 'public' && s !== 'extensions');
    record('INFO', 'schemas', `public + ${foreign.join(', ') || 'none'}`);
    if (foreign.length > 0) {
      record(
        'INFO',
        'platform',
        'non-public schemas present: this database is shared with a platform (Supabase). Confirm with its owner that it may host production CONNECT data.',
      );
    }
  } finally {
    await client.end();
  }

  const width = Math.max(...findings.map(f => f.check.length));
  for (const finding of findings) {
    process.stdout.write(`${finding.verdict.padEnd(5)} ${finding.check.padEnd(width)}  ${finding.detail}\n`);
  }
  const failures = findings.filter(f => f.verdict === 'FAIL').length;
  process.stdout.write(`\n${findings.length} checks, ${failures} FAIL\n`);
  return failures === 0 ? 0 : 1;
}

void main().then(code => {
  process.exitCode = code;
});
