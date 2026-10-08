/**
 * A D1 stand-in on node:sqlite for the Worker tests: in memory, every migration applied, so the SQL the Worker
 * runs is the SQL that is tested. It copies what the Worker relies on (prepare, bind, first, run, all, batch, exec,
 * meta.changes, booleans as 1 and 0, undefined refused) and nothing of D1's limits or replication. Errors are
 * worded as D1 words them, so a test can match on the prefix.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Counter } from '../lib/quota.ts';

type Bindable = string | number | boolean | null | ArrayBuffer | Uint8Array | undefined;
type Row = Record<string, unknown>;

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url).href);

const toSqlite = (value: Bindable): SQLInputValue => {
  if (value === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
};

const asD1Error = (error: unknown): Error =>
  new Error(`D1_ERROR: ${error instanceof Error ? error.message : String(error)}`, { cause: error });

const meta = (changes: number, rows: number, lastRowId: number) => ({
  duration: 0,
  size_after: 0,
  rows_read: rows,
  rows_written: changes,
  last_row_id: lastRowId,
  changed_db: changes > 0,
  changes,
});

class Statement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly params: readonly Bindable[];

  constructor(db: DatabaseSync, sql: string, params: readonly Bindable[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: Bindable[]): Statement {
    return new Statement(this.db, this.sql, values);
  }

  /** Runs the statement: rows for anything that returns them, otherwise the change count. */
  execute(): { results: Row[]; changes: number; lastRowId: number } {
    const params = this.params.map(toSqlite);
    try {
      const statement = this.db.prepare(this.sql);
      if (statement.columns().length > 0) {
        const results = statement.all(...params).map((row) => ({ ...row }));
        return { results, changes: /\breturning\b/i.test(this.sql) ? results.length : 0, lastRowId: 0 };
      }
      const { changes, lastInsertRowid } = statement.run(...params);
      return { results: [], changes: Number(changes), lastRowId: Number(lastInsertRowid) };
    } catch (error) {
      throw asD1Error(error);
    }
  }

  result() {
    const { results, changes, lastRowId } = this.execute();
    return { success: true as const, results, meta: meta(changes, results.length, lastRowId) };
  }

  async run() {
    return this.result();
  }

  async all() {
    return this.result();
  }

  async first(column?: string): Promise<unknown> {
    const [row] = this.execute().results;
    if (!row) return null;
    return column === undefined ? row : (row[column] ?? null);
  }
}

export class TestD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  private broken = false;

  prepare(sql: string): Statement {
    if (this.broken) throw new Error('D1_ERROR: database unavailable');
    return new Statement(this.sqlite, sql);
  }

  /** One transaction: every statement or none. */
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((s) => s.result());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string) {
    try {
      this.sqlite.exec(sql);
    } catch (error) {
      throw asD1Error(error);
    }
    return { count: sql.split(';').filter((s) => s.trim()).length, duration: 0 };
  }

  /** Make every later statement fail, for the fail-open tests. */
  break(): void {
    this.broken = true;
  }

  close(): void {
    this.sqlite.close();
  }
}

/** A fresh in-memory database with every migration applied. */
export function testDatabase(): TestD1 {
  const db = new TestD1();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.sqlite.exec(readFileSync(MIGRATIONS + file, 'utf8'));
  }
  return db;
}

/** The stand-in typed as the binding the Worker sees. */
export const asD1 = (db: TestD1): D1Database => db as unknown as D1Database;

/** A counter row as if `n` events had already happened that day. */
export function seedCounter(db: TestD1, counter: Counter, day: string, n: number): void {
  db.sqlite
    .prepare('INSERT INTO counters (scope, key, day, n) VALUES (?, ?, ?, ?)')
    .run(counter.scope, counter.key, day, n);
}
