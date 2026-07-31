export type StoredMessage = {
  id?: number;
  chatId: string;
  messageId: number;
  date?: string;
  senderId?: string;
  senderName?: string;
  text: string;
  replyToMessageId?: number;
  topicId?: number;
  rawJson?: string;
  deletedAt?: string;
};

export type SyncState = {
  chatId: string;
  oldestMessageId?: number;
  newestMessageId?: number;
  nextBackfillOffsetId?: number;
  recentCatchupMinId?: number;
  recentCatchupNextOffsetId?: number;
  recentCatchupNewestId?: number;
  syncedCount: number;
  lastRecentSyncAt?: string;
  lastBackfillAt?: string;
  backfillExhaustedAt?: string;
  lastError?: string;
  updatedAt?: string;
};

export type DaemonStatus = {
  service: string;
  lastStartedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  updatedAt?: string;
};

export type ChatCacheStatus = {
  chatId: string;
  messages: {
    count: number;
    oldestMessageId?: number;
    newestMessageId?: number;
  };
  syncState: SyncState | null;
  daemonStatus: DaemonStatus | null;
  embeddings: Array<Record<string, unknown>>;
  maintenance: MaintenanceJob[];
};

export type MaintenanceJobStatus = "pending" | "completed";

export type MaintenanceJob = {
  name: string;
  status: MaintenanceJobStatus;
  reason?: string;
  details?: Record<string, unknown>;
  updatedAt?: string;
  completedAt?: string;
};

export type MaintenanceJobName =
  | "messages_fts_rebuild"
  | "embedding_chunk_membership_backfill";

export type KeywordSearchHit = {
  message: StoredMessage;
  rank: number;
};

export type StoredEmbeddingChunk = {
  id: number;
  chatId: string;
  namespace: string;
  startMessageId: number;
  endMessageId: number;
  messageIds: number[];
  messageCount: number;
  text: string;
  model: string;
  dimensions: number;
  embedding: Uint8Array;
  contentHash: string;
  dirtyAt?: string;
  updatedAt: string;
};

export type StaleEmbeddingChunkReason =
  | "missing_message"
  | "deleted_message"
  | "source_changed";

export type StaleEmbeddingChunkRange = {
  chatId: string;
  startMessageId: number;
  endMessageId: number;
  reason: StaleEmbeddingChunkReason;
};

export type EmbeddingChunkCommitResult = {
  committedChunks: number;
  /**
   * Sum of messageCount for committed chunks. Overlap messages are counted
   * once per committed chunk, matching provider input accounting.
   */
  committedMessages: number;
  staleRanges: StaleEmbeddingChunkRange[];
  /**
   * End id of the last contiguous committed input before the first stale
   * chunk. It is intentionally absent when the first input is stale.
   */
  nextAfterMessageId?: number;
};

export type SendOutboxStatus = "queued" | "sending" | "sent" | "failed" | "expired";

export type SendStartupReconciliation = {
  expiredQueued: number;
  markedUnknownDelivery: number;
};

export type StoredSendOutboxItem = {
  id: string;
  dedupeKey?: string;
  payloadHash: string;
  chatId: string;
  replyToMessageId?: number;
  userKey: string;
  status: SendOutboxStatus;
  telegramMessageId?: number;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
  queuedAtMs?: number;
  sendingAtMs?: number;
  sentAtMs?: number;
  expiresAtMs: number;
};

export type SendReservation =
  | {
      kind: "queued";
      outboxId: string;
      expiresAtMs: number;
    }
  | {
      kind: "duplicate_sent";
      outboxId: string;
      chatId: string;
      telegramMessageId?: number;
    };

export type BotDurableStatus =
  | "queued"
  | "running"
  | "drafted"
  | "sending"
  | "sent"
  | "skipped"
  | "failed"
  | "lost_ack"
  | "dead_letter";

export type StoredBotUpdate = {
  updateId: number;
  rawJson: string;
  status: BotDurableStatus;
  addressed: boolean;
  chatId?: string;
  triggerMessageId?: number;
  attempts: number;
  maxAttempts: number;
  error?: string;
  receivedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

export type StoredBotTurn = {
  id: number;
  updateId: number;
  chatId: string;
  triggerMessageId: number;
  status: BotDurableStatus;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
  retryNotBeforeMs?: number;
  draftText?: string;
  telegramMessageId?: number;
  progressMessageId?: number;
  progressState?: BotTurnProgressState;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
};

export type BotTurnProgressState =
  | "none"
  | "dispatching"
  | "active"
  | "unknown";

export type StoredChatMemory = {
  chatId: string;
  memoryText: string;
  lastConsolidatedMessageId?: number;
  revision: number;
  updatedAtMs: number;
};

export type UpsertChatMemoryInput = Omit<
  StoredChatMemory,
  "revision" | "updatedAtMs"
> & {
  updatedAtMs?: number;
};

export type StoredDayDigest = {
  chatId: string;
  day: string;
  startMessageId: number;
  endMessageId: number;
  messageCount: number;
  text: string;
  promptVersion: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  sourceHash?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type StoredDigestRollup = {
  chatId: string;
  kind: "week" | "month";
  period: string;
  dayFrom: string;
  dayTo: string;
  dayCount: number;
  text: string;
  promptVersion: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  sourceHash?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type UpsertDayDigestInput = Omit<
  StoredDayDigest,
  "createdAtMs" | "updatedAtMs"
> & {
  createdAtMs?: number;
};

export type UpsertDigestRollupInput = Omit<
  StoredDigestRollup,
  "createdAtMs" | "updatedAtMs"
> & {
  createdAtMs?: number;
};

export type DigestMessageDateBounds = {
  firstDate: string;
  lastDate: string;
};

export interface MessageStoreOptions {
  /**
   * Opens an already-migrated database without changing its schema, journal
   * mode, or contents. This is used by inspection/dry-run entrypoints.
   */
  readOnly?: boolean;
}

export type BotUpdateIngestResult = {
  disposition: "ingested" | "recovered" | "duplicate";
  /**
   * A polling caller may advance its Telegram offset to this update only
   * after this result exists. It is returned after the inbox/message/turn
   * transaction commits.
   */
  ackUpdateId: number;
  update: StoredBotUpdate;
  turn?: StoredBotTurn;
  /**
   * Present only when an otherwise-addressed trigger was durably ingested but
   * intentionally did not reserve a turn because the persisted per-sender
   * debounce window was still active.
   */
  throttled?: {
    retryAfterMs: number;
  };
};

export type BotUpdateFailureResult = {
  update: StoredBotUpdate;
  /**
   * Poison updates become acknowledgeable only after their bounded retry
   * budget is exhausted and the durable row reaches dead_letter.
   */
  ackUpdateId?: number;
};
