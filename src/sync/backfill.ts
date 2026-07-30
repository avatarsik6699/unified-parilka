import type { StoredMessage } from "../store.js";
import { telegramMessageToStored } from "../telegram/message-converter.js";
import {
  iterateWithOperationTimeout,
  withOperationTimeout,
} from "./abort.js";
import type { HistoryFetchContext } from "./contracts.js";

const TELEGRAM_HISTORY_CHUNK_SIZE = 100;

export async function fetchBackfillHistory(
  context: HistoryFetchContext,
): Promise<void> {
  if (context.target <= 0) {
    return;
  }
  const { config, telegram, store, chat, progress, signal } =
    context;
  const stream = await withOperationTimeout(
    telegram.iterateMessages({
      chat: chat.chatId,
      limit: context.target,
      offsetId: context.offsetId,
      minId: context.minId,
    }),
    config.sync.historyOperationTimeoutMs,
    "Telegram backfill history request",
    signal,
  );
  let rows: StoredMessage[] = [];
  const seen = new Set<string>();
  const flushRows = (): void => {
    if (rows.length === 0) {
      return;
    }
    const batch = rows;
    rows = [];
    progress.saved += store.upsertMessages(chat, batch);
    progress.batches += 1;
  };

  for await (const message of iterateWithOperationTimeout(
    stream.messages,
    config.sync.historyOperationTimeoutMs,
    "Telegram backfill history iterator",
    {
      chunkSize: TELEGRAM_HISTORY_CHUNK_SIZE,
      delayMs: config.sync.historyWaitTimeSec * 1000,
      sleep: context.historySleep,
    },
    signal,
  )) {
    progress.fetched += 1;
    const row = telegramMessageToStored(stream.chat, message);
    if (!row) {
      continue;
    }
    const key = `${row.chatId}:${row.messageId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push(row);
    progress.oldestMessageId =
      progress.oldestMessageId == null
        ? row.messageId
        : Math.min(progress.oldestMessageId, row.messageId);
    progress.newestMessageId =
      progress.newestMessageId == null
        ? row.messageId
        : Math.max(progress.newestMessageId, row.messageId);

    if (rows.length >= context.batchSize) {
      flushRows();
    }
  }
  flushRows();
}
