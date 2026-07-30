import type { StoredMessage } from "../store.js";
import { telegramMessageToStored } from "../telegram/message-converter.js";
import type { ChatInfo } from "../telegram/types.js";
import {
  iterateWithOperationTimeout,
  withOperationTimeout,
} from "./abort.js";
import type {
  HistoryFetchContext,
  SyncResult,
} from "./contracts.js";

const TELEGRAM_HISTORY_CHUNK_SIZE = 100;

export async function fetchRecentHistory(
  context: HistoryFetchContext,
): Promise<number> {
  const { config, telegram, chat, progress, signal } = context;
  let pageOffsetId = context.offsetId;
  let rows: StoredMessage[] = [];
  const seen = new Set<string>();
  const historyPacing = {
    chunkSize: TELEGRAM_HISTORY_CHUNK_SIZE,
    delayMs: config.sync.historyWaitTimeSec * 1000,
    sleep: context.historySleep,
  };
  const flushRows = (): void => {
    if (rows.length === 0) {
      return;
    }
    const batch = rows;
    rows = [];
    progress.saved += context.store.upsertMessages(chat, batch);
    const batchOldestMessageId = Math.min(
      ...batch.map((row) => row.messageId),
    );
    progress.lastFlushedRecentOffsetId =
      progress.lastFlushedRecentOffsetId == null
        ? batchOldestMessageId
        : Math.min(
            progress.lastFlushedRecentOffsetId,
            batchOldestMessageId,
          );
    progress.batches += 1;
  };

  if (context.target <= 0) {
    return pageOffsetId;
  }

  while (true) {
    if (
      pageOffsetId > 0 &&
      context.minId != null &&
      pageOffsetId - context.minId <= 1
    ) {
      break;
    }
    const remainingBudget = Math.max(
      0,
      config.sync.maxSyncLimit - progress.fetched,
    );
    if (remainingBudget <= 0) {
      progress.catchupNextOffsetId =
        pageOffsetId > 0 ? pageOffsetId : undefined;
      break;
    }
    const pageLimit = Math.min(context.target, remainingBudget);
    const stream = await withOperationTimeout(
      telegram.iterateMessages({
        chat: chat.chatId,
        limit: pageLimit,
        offsetId: pageOffsetId,
        minId: context.minId,
      }),
      config.sync.historyOperationTimeoutMs,
      "Telegram recent history request",
      signal,
    );
    let pageFetched = 0;
    let pageOldestMessageId: number | undefined;

    for await (const message of iterateWithOperationTimeout(
      stream.messages,
      config.sync.historyOperationTimeoutMs,
      "Telegram recent history iterator",
      historyPacing,
      signal,
    )) {
      progress.fetched += 1;
      pageFetched += 1;
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
      progress.catchupNewestMessageId =
        progress.catchupNewestMessageId == null
          ? row.messageId
          : Math.max(
              progress.catchupNewestMessageId,
              row.messageId,
            );
      pageOldestMessageId =
        pageOldestMessageId == null
          ? row.messageId
          : Math.min(pageOldestMessageId, row.messageId);

      if (rows.length >= context.batchSize) {
        flushRows();
      }
    }
    flushRows();

    if (
      pageFetched < pageLimit ||
      pageOldestMessageId == null
    ) {
      break;
    }
    if (progress.fetched >= config.sync.maxSyncLimit) {
      progress.catchupNextOffsetId = pageOldestMessageId;
      break;
    }
    pageOffsetId = pageOldestMessageId;
  }

  return progress.catchupNextOffsetId ?? pageOffsetId;
}

export async function reconcileRecentWindow(
  context: Pick<
    HistoryFetchContext,
    "config" | "telegram" | "store" | "chat" | "signal"
  >,
  limit: number,
): Promise<NonNullable<SyncResult["reconciliation"]>> {
  const ids = context.store.getRecentMessageIds(
    context.chat.chatId,
    limit,
  );
  if (ids.length === 0) {
    return { checked: 0, refreshed: 0, deleted: 0 };
  }
  const response = await withOperationTimeout(
    context.telegram.getMessages({
      chat: context.chat.chatId,
      limit: ids.length,
      ids,
    }),
    context.config.sync.historyOperationTimeoutMs,
    "Telegram recent reconciliation lookup",
    context.signal,
  );
  const rows = response.messages
    .map((message) =>
      telegramMessageToStored(response.chat, message),
    )
    .filter((row): row is StoredMessage => row != null);
  const returned = new Set(rows.map((row) => row.messageId));
  const missing = ids.filter((id) => !returned.has(id));
  const refreshed = context.store.upsertMessages(
    context.chat as ChatInfo,
    rows,
  );
  const deleted = context.store.markMessagesDeleted(
    context.chat.chatId,
    missing,
  );
  return { checked: ids.length, refreshed, deleted };
}
