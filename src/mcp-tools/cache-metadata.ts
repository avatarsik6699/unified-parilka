import type {
  ChatCacheStatus,
  SyncState,
} from "../store.js";
import type {
  SyncOnceResult,
  SyncResult,
} from "../sync-engine.js";

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
        message: `Last sync error: ${status.syncState.lastError}`,
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
    sync_state: params.status.syncState,
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
    sync_state: params.status.syncState,
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
