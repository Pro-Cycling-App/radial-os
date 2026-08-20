// The database half of the Radial gatekeeper: a read-only Postgres client over Neon's HTTP driver
// (no sockets, so it works from a Worker or a Durable Object with nothing to pool), plus the
// guardrails every read goes through.
//
// The primary control is the database role: `radial_os` holds SELECT and nothing else, connects to
// the read replica (which rejects writes at the endpoint itself), and carries a 15 s role-level
// statement_timeout. Everything here is defense in depth and caller protection, not the fence.

import { neon } from "@neondatabase/serverless";
import type {
  RadialQueryResult,
  RadialSqlColumn,
  RadialSqlRow,
  RadialSqlValue,
  RadialTable,
  RadialTableColumn,
} from "./types.js";

// Cap on one result, measured as the JSON the rows serialize to. The RPC channel and the calling
// gadget both buffer the whole thing; past this the caller pages with LIMIT/OFFSET.
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

// Primitives that reach outside the database even inside a read-only transaction as a SELECT-only
// role, should the role ever be granted EXECUTE on them. Best-effort and non-exhaustive: the role's
// privileges are the real control.
const SIDE_EFFECT_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /\bdblink(_exec|_open|_send_query)?\s*\(/i, name: "dblink" },
  { pattern: /\bhttp_(get|post|put|delete|head|patch)\s*\(/i, name: "the http extension" },
  { pattern: /\bpg_read_file\s*\(/i, name: "pg_read_file" },
  { pattern: /\bpg_read_binary_file\s*\(/i, name: "pg_read_binary_file" },
  { pattern: /\bpg_ls_dir\s*\(/i, name: "pg_ls_dir" },
  { pattern: /\bpg_stat_file\s*\(/i, name: "pg_stat_file" },
  { pattern: /\blo_(import|export)\s*\(/i, name: "large-object file access" },
  { pattern: /\bcopy\b[\s\S]*?\b(from|to)\s+program\b/i, name: "COPY ... PROGRAM" },
];

/** Throws if `sql` references a primitive with effects outside the database. */
export function assertReadOnlySafe(sql: string): void {
  for (const { pattern, name } of SIDE_EFFECT_PATTERNS) {
    if (pattern.test(sql)) {
      throw new Error(
        `query() is read-only and rejected a reference to ${name}, which can have side effects.`,
      );
    }
  }
}

// Postgres type OIDs the driver reports for the common column types. Anything else is reported by
// its OID, which is still enough for a caller to tell columns apart.
const TYPE_NAMES: Record<number, string> = {
  16: "bool", 17: "bytea", 20: "int8", 21: "int2", 23: "int4", 25: "text", 114: "json",
  700: "float4", 701: "float8", 1042: "bpchar", 1043: "varchar", 1082: "date", 1083: "time",
  1114: "timestamp", 1184: "timestamptz", 1186: "interval", 1700: "numeric", 2950: "uuid",
  3802: "jsonb", 1007: "int4[]", 1009: "text[]", 1015: "varchar[]", 2951: "uuid[]", 3807: "jsonb[]",
};

function typeName(oid: number): string {
  return TYPE_NAMES[oid] ?? `oid:${oid}`;
}

/** A read-only client over one connection string. */
export class RadialDb {
  readonly #sql: ReturnType<typeof neon<false, true>>;

  constructor(connectionString: string) {
    this.#sql = neon(connectionString, { fullResults: true });
  }

  /**
   * Runs one statement. The rows are passed through exactly as the driver decoded them — no
   * shape-based post-processing, since a jsonb value and a serialized anything-else are
   * indistinguishable on the wire.
   */
  async query(sql: string, params: RadialSqlValue[] = []): Promise<RadialQueryResult> {
    assertReadOnlySafe(sql);
    const result = await this.#sql.query(sql, params);
    const rows = result.rows as RadialSqlRow[];
    const encoded = JSON.stringify(rows);
    if (encoded.length > MAX_RESULT_BYTES) {
      throw new Error(
        `query() result is ${encoded.length} bytes of JSON, above the ${MAX_RESULT_BYTES}-byte ` +
        `cap. Add a LIMIT, or page with LIMIT/OFFSET.`,
      );
    }
    const columns: RadialSqlColumn[] = result.fields.map(field => ({
      name: field.name,
      type: typeName(field.dataTypeID),
    }));
    return { rows, columns, rowCount: rows.length };
  }

  async listTables(): Promise<RadialTable[]> {
    const { rows } = await this.query(
      `select table_name as name,
              case table_type when 'VIEW' then 'view' else 'table' end as kind
         from information_schema.tables
        where table_schema = 'public'
        order by table_name`,
    );
    return rows.map(row => ({
      name: String(row.name),
      kind: row.kind === "view" ? "view" : "table",
    }));
  }

  async describeTable(name: string): Promise<RadialTableColumn[]> {
    const { rows } = await this.query(
      `select column_name as name,
              case when data_type = 'USER-DEFINED' then udt_name
                   when data_type = 'ARRAY' then udt_name
                   else data_type end as type,
              is_nullable = 'YES' as nullable,
              column_default as "default"
         from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by ordinal_position`,
      [name],
    );
    if (rows.length === 0) {
      throw new Error(`No table or view named "${name}" in the public schema.`);
    }
    return rows.map(row => ({
      name: String(row.name),
      type: String(row.type),
      nullable: row.nullable === true,
      default: row.default === null ? null : String(row.default),
    }));
  }
}
