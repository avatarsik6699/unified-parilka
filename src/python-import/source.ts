import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CliOptions, ImportReport, SqlRow } from "./contracts.js";
import { updateMessageHash } from "./hashes.js";
import {
  legacyLiveMessage,
  nonNegativeInteger,
  normalizeDayDigest,
  normalizeLegacyMonth,
  normalizeRollup,
} from "./normalization.js";
import { tableExists } from "./sqlite-guards.js";

export function inspectSource(
  source: DatabaseSync,
  options: CliOptions,
): ImportReport {
  const digestRollups = tableCount(source, "digest_roll");
  const legacyMonthDigests = tableCount(source, "digest_month");
  const hash = createHash("sha256");
  let liveMessages = 0;
  if (tableExists(source, "live_msg")) {
    const statement = source.prepare(
      `SELECT message_id, chat_id, date_unix, sender_id, sender_name,
              text, reply_to, edited_at, raw_json, is_bot
       FROM live_msg
       ORDER BY message_id ASC`,
    );
    for (const row of statement.iterate() as Iterable<SqlRow>) {
      const message = legacyLiveMessage(row, options.chatId);
      updateMessageHash(hash, message);
      liveMessages += 1;
    }
  }
  validateDigestRows(source, options.chatId);

  return {
    mode: options.apply ? "applied" : "dry_run",
    source: {
      path: options.sourcePath,
      liveMessages,
      dayDigests: tableCount(source, "digest_day"),
      digestRollups,
      legacyMonthDigests,
      outboxByStatus: outboxCounts(source),
      drafts: tableCount(source, "bot_draft"),
      events: tableCount(source, "event"),
      contentHash: hash.digest("hex"),
    },
    target: {
      path: options.targetPath,
    },
    notes: [
      "Messages and L1/L2 digests are imported idempotently.",
      "Legacy drafts, events, and all outbox rows (including lost_ack) are counted for the cutover report but are never inserted into the live retry queue.",
      "Run against filesystem snapshots while old writers are active; repeat once after stopping them for the final delta.",
    ],
  };
}

function validateDigestRows(
  source: DatabaseSync,
  chatId: string,
): void {
  if (tableExists(source, "digest_day")) {
    const rows = source
      .prepare(
        `SELECT day, start_msg_id, end_msg_id, n_msgs, in_tokens,
                out_tokens, model, prompt_version, text, created_at
         FROM digest_day
         ORDER BY day ASC`,
      )
      .iterate() as Iterable<SqlRow>;
    for (const row of rows) {
      normalizeDayDigest(row, chatId);
    }
  }
  if (tableExists(source, "digest_roll")) {
    const rows = source
      .prepare(
        `SELECT kind, period, day_from, day_to, n_days, prompt_version,
                text, created_at
         FROM digest_roll
         ORDER BY day_from ASC, period ASC`,
      )
      .iterate() as Iterable<SqlRow>;
    for (const row of rows) {
      normalizeRollup(row, chatId);
    }
  }
  if (tableExists(source, "digest_month")) {
    const rows = source
      .prepare(
        `SELECT month, n_days, prompt_version, text, created_at
         FROM digest_month
         ORDER BY month ASC`,
      )
      .iterate() as Iterable<SqlRow>;
    for (const row of rows) {
      normalizeLegacyMonth(row, chatId);
    }
  }
}

function outboxCounts(source: DatabaseSync): Record<string, number> {
  if (!tableExists(source, "bot_outbox")) {
    return {};
  }
  const rows = source
    .prepare(
      "SELECT status, count(*) AS count FROM bot_outbox GROUP BY status ORDER BY status",
    )
    .all() as SqlRow[];
  return Object.fromEntries(
    rows.map((row) => [
      String(row.status),
      nonNegativeInteger(row.count, "bot_outbox.count"),
    ]),
  );
}

function tableCount(source: DatabaseSync, table: string): number {
  if (!tableExists(source, table)) {
    return 0;
  }
  const row = source
    .prepare(`SELECT count(*) AS count FROM "${table}"`)
    .get() as SqlRow;
  return nonNegativeInteger(row.count, `${table}.count`);
}
