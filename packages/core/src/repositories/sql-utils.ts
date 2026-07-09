import type { DbClient } from '../db/client.js';

export function buildUpdateSet(
  patch: Record<string, unknown>,
  startIndex: number,
  alwaysSet: Record<string, unknown> = {},
  allowedColumns?: readonly string[],
): { assignments: string; values: unknown[] } {
  const values: unknown[] = [];
  const parts: string[] = [];
  const allowed = allowedColumns ? new Set(allowedColumns) : null;

  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (allowed && !allowed.has(column)) continue;
    values.push(value);
    parts.push(`${column} = $${startIndex + values.length - 1}`);
  }

  for (const [column, value] of Object.entries(alwaysSet)) {
    if (value === undefined) continue;
    if (allowed && !allowed.has(column)) continue;
    values.push(value);
    parts.push(`${column} = $${startIndex + values.length - 1}`);
  }

  return { assignments: parts.join(', '), values };
}

export async function requireAffected(client: DbClient, sql: string, params: readonly unknown[]): Promise<boolean> {
  const result = await client.query(sql, params);
  return result.rowCount > 0;
}
