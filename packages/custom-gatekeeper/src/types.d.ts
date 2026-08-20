/** Facts about this Radial OS deployment, supplied by the operator. */
export interface RadialDeploymentInfo {
  name: string;
  message: string;
}

/** A JSON value as it comes back from Postgres over the HTTP driver. */
export type RadialSqlValue = string | number | boolean | null | RadialSqlValue[] | { [key: string]: RadialSqlValue };

/** One result row, keyed by column name. */
export type RadialSqlRow = Record<string, RadialSqlValue>;

/** One column of a result set. `type` is the Postgres type name (`int4`, `text`, `uuid`, `jsonb`, …). */
export interface RadialSqlColumn {
  name: string;
  type: string;
}

/** The result of a read-only query. */
export interface RadialQueryResult {
  rows: RadialSqlRow[];
  columns: RadialSqlColumn[];
  rowCount: number;
}

/** A table or view in the Radial database. */
export interface RadialTable {
  name: string;
  kind: "table" | "view";
}

/** One column of a table, from `information_schema.columns`. */
export interface RadialTableColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

/**
 * Read-only access to the Radial production database (Postgres on Neon), the domain data behind
 * the pro-cycling app: races, editions, race days, riders, teams, results, images, and the
 * provenance tables (claims, verdicts, sources) that every fact enters through.
 *
 * Every method is a **read**. The connection uses a role that holds `SELECT` and nothing else on a
 * read replica, with a 15 s statement timeout, so a statement that writes fails at the database.
 * Each call is recorded as an observation in the approval log.
 */
export interface RadialSession {
  /**
   * Runs a read-only SQL statement and returns its rows.
   *
   * `params` bind positionally as `$1`, `$2`, … — always parameterize values rather than
   * interpolating them. Results return in full (no streaming), so include a `LIMIT`; a result
   * above ~4 MB of JSON is rejected. Statements run for at most 15 s.
   *
   * Entity names: `races` → `race_editions` → `race_days`; `riders`, `teams` → `team_years`,
   * `team_memberships`; startlists are `race_entries`; `results`. Use `listTables()` and
   * `describeTable()` to discover the rest — never guess a column.
   */
  query(sql: string, params?: RadialSqlValue[]): Promise<RadialQueryResult>;

  /** Lists the tables and views in the `public` schema. */
  listTables(): Promise<RadialTable[]>;

  /** Describes the columns of one `public` table or view. Throws if it does not exist. */
  describeTable(name: string): Promise<RadialTableColumn[]>;

  /** Returns the operator-supplied description of this deployment. */
  getDeploymentInfo(): Promise<RadialDeploymentInfo>;
}
