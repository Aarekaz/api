// @ts-expect-error vitest runs in Node; the Worker tsconfig has no Node types.
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error same as above (node:sqlite is Node's built-in SQLite).
import { DatabaseSync } from "node:sqlite";

/**
 * One D1 for every route test: Node's built-in SQLite behind the parts of the
 * D1 API the Worker uses (prepare/bind/first/all/run/raw, batch as one
 * transaction, exec). `run()` and `all()` both return a read's rows and
 * RETURNING rows, the way D1 does, so `INSERT ... RETURNING *` works whichever
 * one the code calls and a batch of SELECTs gets its rows back.
 */

export interface Sqlite {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    setReturnArrays?(on: boolean): void;
  };
}

export interface TestD1 {
  /** The SQLite database underneath, for setting up and checking rows directly. */
  db: Sqlite;
  /** The D1 binding to put in `env.DB`. */
  DB: D1Database;
  /** Every statement the code prepared, in order. */
  queries: string[];
}

const isRead = (sql: string) => /^\s*(select|with|pragma|values)\b/i.test(sql) && !/\breturning\b/i.test(sql);

/** Every migration file name, in order (without the folder). */
export function allMigrations(): string[] {
  return (readdirSync("migrations") as string[]).filter((name) => name.endsWith(".sql")).sort();
}

/**
 * A fresh in-memory D1. `migrations` are file names in migrations/ (with or
 * without .sql) or "all"; `sql` runs after them (tables older migrations
 * assumed, test rows).
 */
export function testD1(options: { migrations?: string[] | "all"; sql?: string | string[] } = {}): TestD1 {
  const db = new DatabaseSync(":memory:") as Sqlite;
  const files = options.migrations === "all" ? allMigrations() : options.migrations ?? [];
  for (const file of files) db.exec(readFileSync(`migrations/${file.endsWith(".sql") ? file : `${file}.sql`}`, "utf8"));
  for (const sql of [options.sql ?? []].flat()) db.exec(sql);
  const queries: string[] = [];

  const statement = (sql: string, args: unknown[] = []) => {
    const normalized = args.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v));
    const rows = <T>() => db.prepare(sql).all(...normalized) as T[];
    const changes = () => Number((db.prepare("SELECT changes() AS n").get() as { n: number }).n);
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      async first<T>(column?: string): Promise<T | null> {
        const row = (db.prepare(sql).get(...normalized) as Record<string, unknown> | undefined) ?? null;
        if (row && column) return (row[column] as T) ?? null;
        return row as T | null;
      },
      async all<T>() {
        const results = rows<T>();
        return { results, success: true, meta: { changes: isRead(sql) ? 0 : changes() } };
      },
      async run<T>() {
        // D1's run() (and so batch()) carries a read's rows, like all().
        if (isRead(sql)) return { results: rows<T>(), success: true, meta: { changes: 0, last_row_id: 0 } };
        if (/\breturning\b/i.test(sql)) {
          const results = rows<T>();
          return { results, success: true, meta: { changes: results.length, last_row_id: 0 } };
        }
        const info = db.prepare(sql).run(...normalized);
        return { results: [] as T[], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
      async raw<T>() {
        return rows<Record<string, unknown>>().map((row) => Object.values(row)) as T[];
      },
    };
  };

  const DB = {
    prepare: (sql: string) => { queries.push(sql); return statement(sql); },
    async batch(list: Array<{ run: () => Promise<unknown> }>) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) { db.exec(sql); return { count: 1, duration: 0 }; },
  } as unknown as D1Database;

  return { db, DB, queries };
}
