import type {
  ChatCacheStatus,
  DaemonStatus,
  SyncState,
} from "../store.js";
import { publicNormalizedError } from "../errors.js";
import type {
  SyncOnceResult,
  SyncResult,
} from "../sync-engine.js";

const STORED_SYNC_FAILURE_MESSAGE =
  "A sync failure was recorded.";
const STORED_DAEMON_FAILURE_MESSAGE =
  "A daemon failure was recorded.";

export function syncOnceStatus(
  result: SyncOnceResult,
): "done" | "failed" | "partial" | "skipped" | "catching_up" {
  const statuses = [
    result.recent?.status,
    result.backfill?.status,
  ].filter(
    (status): status is SyncResult["status"] =>
      status != null,
  );
  if (statuses.length === 0) {
    return "skipped";
  }
  if (statuses.every((status) => status === "done")) {
    return "done";
  }
  if (statuses.every((status) => status === "catching_up")) {
    return "catching_up";
  }
  if (statuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  if (statuses.every((status) => status === "failed")) {
    return "failed";
  }
  return "partial";
}

export function recentCatchupSummary(
  state: SyncState | null | undefined,
): Record<string, unknown> | null {
  if (!state?.recentCatchupNextOffsetId) {
    return null;
  }
  return {
    status: "catching_up",
    minMessageId: state.recentCatchupMinId,
    nextOffsetId: state.recentCatchupNextOffsetId,
    newestMessageId: state.recentCatchupNewestId,
  };
}

/** Public projection of a sync-state row with persisted failure text removed. */
export function publicSyncState(
  state: SyncState | null | undefined,
): Record<string, unknown> | null {
  if (!state) {
    return null;
  }
  return {
    chatId: state.chatId,
    oldestMessageId: state.oldestMessageId,
    newestMessageId: state.newestMessageId,
    nextBackfillOffsetId: state.nextBackfillOffsetId,
    recentCatchupMinId: state.recentCatchupMinId,
    recentCatchupNextOffsetId:
      state.recentCatchupNextOffsetId,
    recentCatchupNewestId: state.recentCatchupNewestId,
    syncedCount: state.syncedCount,
    lastRecentSyncAt: state.lastRecentSyncAt,
    lastBackfillAt: state.lastBackfillAt,
    backfillExhaustedAt: state.backfillExhaustedAt,
    lastError: state.lastError
      ? STORED_SYNC_FAILURE_MESSAGE
      : undefined,
    hasLastError: Boolean(state.lastError),
    updatedAt: state.updatedAt,
  };
}

/** Public projection of daemon status with persisted failure text removed. */
export function publicDaemonStatus(
  status: DaemonStatus | null | undefined,
): Record<string, unknown> | null {
  if (!status) {
    return null;
  }
  return {
    service: status.service,
    lastStartedAt: status.lastStartedAt,
    lastSuccessAt: status.lastSuccessAt,
    lastFailureAt: status.lastFailureAt,
    lastError: status.lastError
      ? STORED_DAEMON_FAILURE_MESSAGE
      : undefined,
    hasLastError: Boolean(status.lastError),
    consecutiveFailures: status.consecutiveFailures,
    updatedAt: status.updatedAt,
  };
}

/** Public projection for a direction result returned by the sync engine. */
export function publicSyncResult(
  result: SyncResult,
): Record<string, unknown> {
  return {
    mode: result.mode,
    status: result.status,
    chat: result.chat,
    jobId: result.jobId,
    requested: result.requested,
    fetched: result.fetched,
    saved: result.saved,
    batches: result.batches,
    nextOffsetId: result.nextOffsetId,
    oldestMessageId: result.oldestMessageId,
    newestMessageId: result.newestMessageId,
    skipped: result.skipped,
    reconciliation: result.reconciliation,
    catchup: result.catchup,
    error: result.error
      ? publicNormalizedError(result.error)
      : undefined,
  };
}

/** Public projection for a combined sync result returned by the sync engine. */
export function publicSyncOnceResult(
  result: SyncOnceResult,
): Record<string, unknown> {
  return {
    chat: result.chat,
    recent: result.recent
      ? publicSyncResult(result.recent)
      : undefined,
    backfill: result.backfill
      ? publicSyncResult(result.backfill)
      : undefined,
  };
}

/**
 * getStats intentionally returns raw SQLite-shaped records for internal users.
 * This adapter keeps its useful counters while removing any persisted error
 * text before a tool response serializes it.
 */
export function publicChatStats(
  stats: Record<string, unknown>,
): Record<string, unknown> {
  return {
    count: publicNumber(stats.count),
    oldest_message_id: publicNumber(stats.oldest_message_id),
    newest_message_id: publicNumber(stats.newest_message_id),
    syncState: publicStoredSyncState(stats.syncState),
    daemonStatus: publicStoredDaemonStatus(stats.daemonStatus),
    embeddings: publicEmbeddingStats(stats.embeddings),
    maintenance: publicMaintenance(stats.maintenance),
  };
}

export function publicEmbeddingStats(
  stats: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(stats)) {
    return [];
  }
  return stats.flatMap((stat) => {
    if (!isRecord(stat)) {
      return [];
    }
    return [{
      namespace: publicString(stat.namespace),
      model: publicString(stat.model),
      dimensions: publicNumber(stat.dimensions),
      chunks: publicNumber(stat.chunks),
      oldest_message_id: publicNumber(stat.oldest_message_id),
      newest_message_id: publicNumber(stat.newest_message_id),
      indexed_messages: publicNumber(stat.indexed_messages),
      dirty_chunks: publicNumber(stat.dirty_chunks),
      updated_at: publicString(stat.updated_at),
      cache_messages: publicNumber(stat.cache_messages),
      uncovered_messages: publicNumber(stat.uncovered_messages),
      uncovered_ranges: publicNumber(stat.uncovered_ranges),
    }];
  });
}

export function publicMaintenance(
  maintenance: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(maintenance)) {
    return [];
  }
  return maintenance.flatMap((job) => {
    if (!isRecord(job)) {
      return [];
    }
    return [{
      name: publicString(job.name),
      status: publicString(job.status),
      hasReason: job.reason != null,
      hasDetails: job.details != null,
      updatedAt: publicString(job.updatedAt),
      completedAt: publicString(job.completedAt),
    }];
  });
}

function publicStoredSyncState(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const hasLastError =
    value.last_error != null || value.lastError != null;
  return {
    chat_id: publicString(value.chat_id),
    oldest_message_id: publicNumber(value.oldest_message_id),
    newest_message_id: publicNumber(value.newest_message_id),
    next_backfill_offset_id: publicNumber(
      value.next_backfill_offset_id,
    ),
    recent_catchup_min_id: publicNumber(
      value.recent_catchup_min_id,
    ),
    recent_catchup_next_offset_id: publicNumber(
      value.recent_catchup_next_offset_id,
    ),
    recent_catchup_newest_id: publicNumber(
      value.recent_catchup_newest_id,
    ),
    synced_count: publicNumber(value.synced_count),
    last_recent_sync_at: publicString(
      value.last_recent_sync_at,
    ),
    last_backfill_at: publicString(value.last_backfill_at),
    backfill_exhausted_at: publicString(
      value.backfill_exhausted_at,
    ),
    last_error: hasLastError
      ? STORED_SYNC_FAILURE_MESSAGE
      : undefined,
    has_last_error: hasLastError,
    updated_at: publicString(value.updated_at),
  };
}

function publicStoredDaemonStatus(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasLastError =
    value.lastError != null || value.last_error != null;
  return {
    service: publicString(value.service),
    lastStartedAt: publicString(value.lastStartedAt),
    lastSuccessAt: publicString(value.lastSuccessAt),
    lastFailureAt: publicString(value.lastFailureAt),
    lastError: hasLastError
      ? STORED_DAEMON_FAILURE_MESSAGE
      : undefined,
    hasLastError,
    consecutiveFailures: publicNumber(
      value.consecutiveFailures,
    ),
    updatedAt: publicString(value.updatedAt),
  };
}

function publicNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function publicString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

type HealthIssue = {
  severity: "unknown" | "warning" | "critical";
  message: string;
};

export function healthSummary(
  status: ChatCacheStatus,
  intervalMs: number,
): Record<string, unknown> {
  const thresholds = healthThresholds(intervalMs);
  const recentLagMs = timestampAgeMs(
    status.syncState?.lastRecentSyncAt,
  );
  const daemonSuccessLagMs = timestampAgeMs(
    status.daemonStatus?.lastSuccessAt,
  );
  const issues: HealthIssue[] = [];

  if (!status.syncState) {
    issues.push({
      severity: "unknown",
      message:
        "No sync_state row has been recorded for this chat.",
    });
  } else {
    if (status.syncState.lastError) {
      issues.push({
        severity: "warning",
        message: STORED_SYNC_FAILURE_MESSAGE,
      });
    }
    if (recentLagMs == null) {
      issues.push({
        severity: "warning",
        message:
          "Recent sync has not recorded a successful timestamp yet.",
      });
    } else if (recentLagMs >= thresholds.recentCriticalMs) {
      issues.push({
        severity: "critical",
        message:
          "Recent sync lag is above the critical threshold.",
      });
    } else if (recentLagMs >= thresholds.recentWarningMs) {
      issues.push({
        severity: "warning",
        message:
          "Recent sync lag is above the warning threshold.",
      });
    }
  }

  if (!status.daemonStatus) {
    issues.push({
      severity: "unknown",
      message: "No daemon_status row has been recorded yet.",
    });
  } else {
    if (
      status.daemonStatus.consecutiveFailures >=
      thresholds.daemonCriticalFailures
    ) {
      issues.push({
        severity: "critical",
        message:
          "Daemon has reached the critical consecutive failure threshold.",
      });
    } else if (status.daemonStatus.consecutiveFailures > 0) {
      issues.push({
        severity: "warning",
        message: "Daemon has consecutive failures.",
      });
    }
    if (daemonSuccessLagMs == null) {
      issues.push({
        severity: "warning",
        message:
          "Daemon has not recorded a successful tick yet.",
      });
    } else if (
      daemonSuccessLagMs >=
      thresholds.daemonSuccessCriticalMs
    ) {
      issues.push({
        severity: "critical",
        message:
          "Daemon success lag is above the critical threshold.",
      });
    } else if (
      daemonSuccessLagMs >=
      thresholds.daemonSuccessWarningMs
    ) {
      issues.push({
        severity: "warning",
        message:
          "Daemon success lag is above the warning threshold.",
      });
    }
  }

  const state = issues.some(
    (issue) => issue.severity === "critical",
  )
    ? "critical"
    : issues.some((issue) => issue.severity === "warning")
      ? "degraded"
      : issues.some((issue) => issue.severity === "unknown")
        ? "unknown"
        : "ok";

  return {
    status: state,
    checkedAt: new Date().toISOString(),
    recentLagMs,
    daemonSuccessLagMs,
    thresholds,
    issues,
  };
}

export function historyCacheMetadata(params: {
  status: ChatCacheStatus;
  beforeId?: number;
  afterId?: number;
  returnedCount: number;
}): Record<string, unknown> {
  const relation = historyCacheRelation(params);
  return {
    range: cacheRange(params.status),
    sync_state: publicSyncState(params.status.syncState),
    returned_count: params.returnedCount,
    relation,
    empty_reason:
      params.returnedCount === 0
        ? emptyReason(relation)
        : undefined,
  };
}

export function contextCacheMetadata(params: {
  status: ChatCacheStatus;
  messageId: number;
  before: number;
  after: number;
  returnedCount: number;
}): Record<string, unknown> {
  const startMessageId = Math.max(
    1,
    params.messageId - params.before,
  );
  const endMessageId = params.messageId + params.after;
  const relation = contextCacheRelation(
    params.status,
    startMessageId,
    endMessageId,
  );
  return {
    range: cacheRange(params.status),
    sync_state: publicSyncState(params.status.syncState),
    requested_range: {
      start_message_id: startMessageId,
      end_message_id: endMessageId,
    },
    relation,
    empty_reason:
      params.returnedCount === 0
        ? emptyReason(relation)
        : undefined,
  };
}

function healthThresholds(
  intervalMs: number,
): Record<string, number> {
  return {
    recentWarningMs: Math.max(intervalMs * 3, 5 * 60_000),
    recentCriticalMs: Math.max(intervalMs * 10, 30 * 60_000),
    daemonSuccessWarningMs: Math.max(
      intervalMs * 3,
      5 * 60_000,
    ),
    daemonSuccessCriticalMs: Math.max(
      intervalMs * 10,
      30 * 60_000,
    ),
    daemonCriticalFailures: 3,
  };
}

function timestampAgeMs(
  timestamp: string | undefined,
): number | undefined {
  const parsed = parseTimestampMs(timestamp);
  if (parsed == null) {
    return undefined;
  }
  return Math.max(0, Date.now() - parsed);
}

function parseTimestampMs(
  timestamp: string | undefined,
): number | undefined {
  if (!timestamp) {
    return undefined;
  }
  const normalized = timestamp.includes("T")
    ? timestamp
    : `${timestamp.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cacheRange(
  status: ChatCacheStatus,
): Record<string, unknown> {
  return {
    message_count: status.messages.count,
    oldest_message_id: status.messages.oldestMessageId,
    newest_message_id: status.messages.newestMessageId,
  };
}

function historyCacheRelation(params: {
  status: ChatCacheStatus;
  beforeId?: number;
  afterId?: number;
}): Record<string, unknown> {
  const range = params.status.messages;
  if (
    range.count === 0 ||
    range.oldestMessageId == null ||
    range.newestMessageId == null
  ) {
    return {
      completeness: "empty_cache",
      outside_cached_range: true,
      partial_cached_range: false,
      requested_before_cached_range: false,
      requested_after_cached_range: false,
    };
  }
  const impossibleRange =
    params.beforeId != null &&
    params.afterId != null &&
    params.afterId >= params.beforeId;
  const requestedBeforeCachedRange =
    params.beforeId != null &&
    params.beforeId <= range.oldestMessageId;
  const requestedAfterCachedRange =
    params.afterId != null &&
    params.afterId >= range.newestMessageId;
  const mayOmitOlderMessages =
    params.afterId != null &&
    params.afterId < range.oldestMessageId;
  const mayOmitNewerMessages =
    params.beforeId != null &&
    params.beforeId > range.newestMessageId;
  const outsideCachedRange =
    requestedBeforeCachedRange || requestedAfterCachedRange;
  const partialCachedRange =
    !outsideCachedRange &&
    (mayOmitOlderMessages || mayOmitNewerMessages);
  return {
    completeness: impossibleRange
      ? "no_matching_message_ids"
      : outsideCachedRange
        ? "outside_cached_range"
        : partialCachedRange
          ? "partial_cached_range"
          : "within_cached_range",
    outside_cached_range: outsideCachedRange,
    partial_cached_range: partialCachedRange,
    requested_before_cached_range: requestedBeforeCachedRange,
    requested_after_cached_range: requestedAfterCachedRange,
    may_omit_older_messages: mayOmitOlderMessages,
    may_omit_newer_messages: mayOmitNewerMessages,
  };
}

function contextCacheRelation(
  status: ChatCacheStatus,
  startMessageId: number,
  endMessageId: number,
): Record<string, unknown> {
  const range = status.messages;
  if (
    range.count === 0 ||
    range.oldestMessageId == null ||
    range.newestMessageId == null
  ) {
    return {
      completeness: "empty_cache",
      outside_cached_range: true,
      partial_cached_range: false,
      requested_before_cached_range: false,
      requested_after_cached_range: false,
    };
  }
  const requestedBeforeCachedRange =
    endMessageId < range.oldestMessageId;
  const requestedAfterCachedRange =
    startMessageId > range.newestMessageId;
  const outsideCachedRange =
    requestedBeforeCachedRange || requestedAfterCachedRange;
  const partialCachedRange =
    !outsideCachedRange &&
    (startMessageId < range.oldestMessageId ||
      endMessageId > range.newestMessageId);
  return {
    completeness: outsideCachedRange
      ? "outside_cached_range"
      : partialCachedRange
        ? "partial_cached_range"
        : "within_cached_range",
    outside_cached_range: outsideCachedRange,
    partial_cached_range: partialCachedRange,
    requested_before_cached_range: requestedBeforeCachedRange,
    requested_after_cached_range: requestedAfterCachedRange,
    may_omit_older_messages:
      !outsideCachedRange &&
      startMessageId < range.oldestMessageId,
    may_omit_newer_messages:
      !outsideCachedRange &&
      endMessageId > range.newestMessageId,
  };
}

function emptyReason(
  relation: Record<string, unknown>,
): string | undefined {
  switch (relation.completeness) {
    case "empty_cache":
      return "cache_empty";
    case "outside_cached_range":
      return relation.requested_before_cached_range
        ? "requested_before_cached_range"
        : "requested_after_cached_range";
    case "no_matching_message_ids":
      return "filters_exclude_all_message_ids";
    case "partial_cached_range":
      return "no_cached_rows_in_partial_cached_range";
    case "within_cached_range":
      return "no_cached_rows_in_requested_range";
    default:
      return undefined;
  }
}
