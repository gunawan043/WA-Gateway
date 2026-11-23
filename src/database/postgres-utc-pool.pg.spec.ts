/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { assertDataConnectionUtc, postgresUtcExtra } from './postgres-utc';

/**
 * The UTC pin through a pool, which is the shape a managed deployment actually uses.
 *
 * `postgres-utc.pg.spec.ts` proves the pin on the connection a DataSource hands out. It does not
 * prove the property that a pooler can break: that EVERY backend the pool opens carries the pin, not
 * just the one that served the first query. A pooler hands a client whichever backend it chooses, so
 * a pin applied once at boot can be lost on the next query while the process keeps running.
 *
 * This suite therefore forces the pool to open several connections (concurrent queries on a small
 * pool) and reads the effective zone from each. It deliberately touches no table: the failure it
 * guards against is a session setting, not data.
 *
 * The connection is the one in `.env`/CI. In the managed validation environment it is a Supabase
 * pooler in session mode, so this is a pooler test, not a direct-connection test. In transaction
 * mode a pooler discards the per-connection `SET` between transactions; the procedure in
 * `docs/integration/alim-connect-pdca-cycle-2.md` §7 describes how to recognise that, and
 * `assertDataConnectionUtc` is the check that fails boot when it happens.
 */
const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';

(POSTGRES_ENABLED ? describe : describe.skip)('postgres UTC pin through a pool', () => {
  const connectionOptions = {
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };

  it('pins every connection the pool opens, not only the first', async () => {
    const pool = new DataSource({
      type: 'postgres',
      ...connectionOptions,
      extra: {
        ...postgresUtcExtra(),
        // Small on purpose: eight concurrent queries must open more than one backend.
        max: 4,
      },
    });

    await pool.initialize();

    try {
      const readings: Array<{ zone: string; offset_seconds: number; offset_seconds_later: number }> = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const rows: Array<{ zone: string; offset_seconds: number; offset_seconds_later: number }> = await pool.query(
            `SELECT current_setting('TimeZone') AS zone,
                        EXTRACT(TIMEZONE FROM now())::int AS offset_seconds,
                        EXTRACT(TIMEZONE FROM now() + interval '6 months')::int AS offset_seconds_later,
                        pg_sleep(0.05) AS wait`,
          );

          return rows[0];
        }),
      );

      expect(readings.map(row => row.offset_seconds)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(readings.map(row => row.offset_seconds_later)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(new Set(readings.map(row => row.zone))).toEqual(new Set(['UTC']));

      // The check boot runs, against the same pool.
      await expect(assertDataConnectionUtc(pool)).resolves.toBeUndefined();
    } finally {
      await pool.destroy();
    }
  }, 120_000);

  it('reads a naive timestamp written by the server default as the same instant it wrote', async () => {
    const pool = new DataSource({ type: 'postgres', ...connectionOptions, extra: postgresUtcExtra() });
    await pool.initialize();

    try {
      // `DEFAULT now()` is the writer the driver cannot influence; it is the one that drifts when the
      // session is not pinned. Comparing it against the driver's own clock is the property a restore
      // and a retention window both depend on.
      const rows: Array<{ written: Date; server: Date }> = await pool.query(
        `SELECT (SELECT now()::timestamp) AS written, now() AS server`,
      );

      expect(rows[0].written).toBeInstanceOf(Date);
      expect(Math.abs(rows[0].written.getTime() - rows[0].server.getTime())).toBeLessThan(5_000);
      // And the driver parses it as UTC: the same instant, not one shifted by the host's offset.
      expect(Math.abs(rows[0].written.getTime() - Date.now())).toBeLessThan(60_000);
    } finally {
      await pool.destroy();
    }
  }, 60_000);
});
