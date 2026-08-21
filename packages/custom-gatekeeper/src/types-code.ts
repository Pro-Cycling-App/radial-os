// Generated from types.d.ts by `pnpm run types:code` -- edit types.d.ts, then regenerate.
const TYPES_CODE = `/** Facts about this Radial OS deployment, supplied by the operator. */
export interface RadialDeploymentInfo {
  name: string;
  message: string;
}

/** A JSON value as it comes back from Postgres over the HTTP driver. */
export type RadialSqlValue = string | number | boolean | null | RadialSqlValue[] | { [key: string]: RadialSqlValue };

/** One result row, keyed by column name. */
export type RadialSqlRow = Record<string, RadialSqlValue>;

/** One column of a result set. \`type\` is the Postgres type name (\`int4\`, \`text\`, \`uuid\`, \`jsonb\`, …). */
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

/** One branch of the Neon project behind the Radial database. */
export interface RadialBranch {
  /** The branch name — what \`branch\` options take. */
  name: string;
  id: string;
  /** The project's default branch: production. */
  isDefault: boolean;
  createdAt: string;
}

/** Which branch a read targets. Omitted means production. */
export interface RadialReadOptions {
  branch?: string;
}

/** One column of a table, from \`information_schema.columns\`. */
export interface RadialTableColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

/**
 * Read-only access to the Radial database (Postgres on Neon), the domain data behind the
 * pro-cycling app: races, editions, race days, riders, teams, results, images, and the provenance
 * tables (claims, verdicts, sources) that every fact enters through.
 *
 * Every method is a **read**. The connection uses a role that holds \`SELECT\` and nothing else,
 * with a 15 s statement timeout, so a statement that writes fails at the database. Each call is
 * recorded as an observation in the approval log.
 *
 * Reads target **production** unless \`{ branch }\` names another Neon branch (\`listBranches()\`),
 * e.g. \`development\`, where schema changes land first. Show the branch whenever it is not
 * production: another branch's numbers are not the app's.
 */
export interface RadialSession {
  /**
   * Runs a read-only SQL statement and returns its rows.
   *
   * \`params\` bind positionally as \`$1\`, \`$2\`, … — always parameterize values rather than
   * interpolating them. Results return in full (no streaming), so include a \`LIMIT\`; a result
   * above ~4 MB of JSON is rejected. Statements run for at most 15 s.
   *
   * Entity names: \`races\` → \`race_editions\` → \`race_days\`; \`riders\`, \`teams\` → \`team_years\`,
   * \`team_memberships\`; startlists are \`race_entries\`; \`results\`. Use \`listTables()\` and
   * \`describeTable()\` to discover the rest — never guess a column.
   */
  query(sql: string, params?: RadialSqlValue[], options?: RadialReadOptions): Promise<RadialQueryResult>;

  /** Lists the tables and views in the \`public\` schema. */
  listTables(options?: RadialReadOptions): Promise<RadialTable[]>;

  /** Describes the columns of one \`public\` table or view. Throws if it does not exist. */
  describeTable(name: string, options?: RadialReadOptions): Promise<RadialTableColumn[]>;

  /** The Neon branches a read can target. Cached for a minute; \`refreshBranches()\` re-reads now. */
  listBranches(): Promise<RadialBranch[]>;

  /** Re-reads the branch list from Neon, for a branch created since the last list. */
  refreshBranches(): Promise<RadialBranch[]>;

  /** Returns the operator-supplied description of this deployment. */
  getDeploymentInfo(): Promise<RadialDeploymentInfo>;
}
`;

export default TYPES_CODE;
