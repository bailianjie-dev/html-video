export interface DbQueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<T>>;
}

export interface DbTransaction extends DbClient {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface TransactionalDbClient extends DbClient {
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}

export function firstRow<T>(result: DbQueryResult<T>): T | null {
  return result.rows[0] ?? null;
}
