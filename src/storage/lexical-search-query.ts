import type { DatabaseSync } from "node:sqlite";
import { rowToStoredMessage } from "./mappers.js";
import { toSqlValues } from "./sqlite-utils.js";
import type { KeywordSearchHit, LexicalSearchOrder } from "./types.js";

/**
 * Executes the already-built WHERE clause/values for `searchLexical`.
 * Split out of `messages.ts` purely to keep that file's line count within
 * the architecture ceiling; it has no state of its own.
 */
export function runLexicalSearch(
  db: DatabaseSync,
  clauses: readonly string[],
  values: readonly unknown[],
  hasQuery: boolean,
  order: LexicalSearchOrder,
): KeywordSearchHit[] {
  const where = clauses.join(" AND ");
  const bound = toSqlValues(values);

  // A sender-only lookup (no FTS terms) has no FTS join and no BM25 rank to
  // sort by -- always newest-first, regardless of the requested order.
  if (!hasQuery) {
    const rows = db
      .prepare(
        `SELECT m.* FROM messages m WHERE ${where} ORDER BY m.message_id DESC LIMIT ?`,
      )
      .all(...bound) as Record<string, unknown>[];
    return rows.map((row) => ({ message: rowToStoredMessage(row), rank: 0 }));
  }

  if (order === "relevance") {
    const rows = db
      .prepare(
        `SELECT m.*, bm25(messages_fts) AS fts_rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE ${where}
         ORDER BY fts_rank ASC, m.message_id DESC
         LIMIT ?`,
      )
      .all(...bound) as Record<string, unknown>[];
    return rows.map((row) => ({
      message: rowToStoredMessage(row),
      rank: Number(row.fts_rank ?? 0),
    }));
  }

  const rows = db
    .prepare(
      `SELECT m.*
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE ${where}
       ORDER BY m.message_id ${order === "newest" ? "DESC" : "ASC"}
       LIMIT ?`,
    )
    .all(...bound) as Record<string, unknown>[];
  return rows.map((row) => ({ message: rowToStoredMessage(row), rank: 0 }));
}
