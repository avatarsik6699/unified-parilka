import type { DatabaseSync } from "node:sqlite";
import {
  EMBEDDING_MEMBERSHIP_JOB,
  type DeferredMaintenanceJobReport,
  type DeferredMaintenanceStatus,
} from "./contracts.js";
import {
  completeMaintenanceJob,
  getMaintenanceJob,
  progressInteger,
  reportStatus,
  safePositiveInteger,
  updatePendingMaintenanceJob,
} from "./jobs.js";
import { scalarCount } from "./schema.js";
import { immediateTransaction } from "./transactions.js";

const MAX_EMBEDDING_CHUNK_MESSAGE_COUNT = 1_000;

export function inspectEmbeddingMembershipBackfill(
  db: DatabaseSync,
): DeferredMaintenanceJobReport {
  const job = getMaintenanceJob(db, EMBEDDING_MEMBERSHIP_JOB);
  if (job?.status !== "pending") {
    return {
      name: EMBEDDING_MEMBERSHIP_JOB,
      status: reportStatus(job),
      batches: 0,
      processedRows: 0,
      remainingRows: 0,
    };
  }
  const targetMaxChunkId =
    progressInteger(job.details.targetMaxChunkId) ??
    maxEmbeddingChunkId(db);
  const lastChunkId =
    progressInteger(job.details.lastChunkId) ?? 0;
  return {
    name: EMBEDDING_MEMBERSHIP_JOB,
    status: "pending",
    batches: 0,
    processedRows: 0,
    remainingRows: countRemainingEmbeddingChunks(
      db,
      lastChunkId,
      targetMaxChunkId,
    ),
  };
}

export function processEmbeddingMembershipBackfill(
  db: DatabaseSync,
  batchSize: number,
  maxBatches: number,
): DeferredMaintenanceJobReport {
  const initial = getMaintenanceJob(db, EMBEDDING_MEMBERSHIP_JOB);
  if (initial?.status !== "pending") {
    return inspectEmbeddingMembershipBackfill(db);
  }
  let batches = 0;
  let processedRows = 0;
  let remainingRows =
    inspectEmbeddingMembershipBackfill(db).remainingRows;
  let status: DeferredMaintenanceStatus = "pending";

  while (status === "pending" && batches < maxBatches) {
    const batch = processEmbeddingMembershipBatch(db, batchSize);
    batches += batch.ran ? 1 : 0;
    processedRows += batch.processedRows;
    remainingRows = batch.remainingRows;
    status = batch.status;
    if (!batch.ran) {
      break;
    }
  }
  return {
    name: EMBEDDING_MEMBERSHIP_JOB,
    status,
    batches,
    processedRows,
    remainingRows,
  };
}

function processEmbeddingMembershipBatch(
  db: DatabaseSync,
  batchSize: number,
): {
  status: DeferredMaintenanceStatus;
  ran: boolean;
  processedRows: number;
  remainingRows: number;
} {
  return immediateTransaction(db, () => {
    const job = getMaintenanceJob(
      db,
      EMBEDDING_MEMBERSHIP_JOB,
    );
    if (job?.status !== "pending") {
      return {
        status: reportStatus(job),
        ran: false,
        processedRows: 0,
        remainingRows: 0,
      };
    }
    const targetMaxChunkId =
      progressInteger(job.details.targetMaxChunkId) ??
      maxEmbeddingChunkId(db);
    const lastChunkId =
      progressInteger(job.details.lastChunkId) ?? 0;
    if (targetMaxChunkId < lastChunkId) {
      throw new Error(
        "Embedding membership cursor is beyond its target.",
      );
    }
    const sourceSnapshotAt =
      typeof job.details.sourceSnapshotAt === "string" &&
      Number.isFinite(Date.parse(job.details.sourceSnapshotAt))
        ? job.details.sourceSnapshotAt
        : job.updatedAt;
    if (!Number.isFinite(Date.parse(sourceSnapshotAt))) {
      throw new Error(
        "Embedding membership has no valid source snapshot.",
      );
    }

    const chunks = db
      .prepare(
        `SELECT id, chat_id, start_message_id, end_message_id,
                message_count
         FROM message_embedding_chunks
         WHERE id > ? AND id <= ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(
        lastChunkId,
        targetMaxChunkId,
        batchSize,
      ) as Array<Record<string, unknown>>;
    const selectMessages = db.prepare(
      `SELECT message_id
       FROM messages
       WHERE chat_id = ?
         AND message_id BETWEEN ? AND ?
         AND length(trim(text)) > 0
         AND deleted_at IS NULL
       ORDER BY message_id ASC
       LIMIT ?`,
    );
    const deleteMembership = db.prepare(
      `DELETE FROM message_embedding_chunk_messages
       WHERE chunk_id = ?`,
    );
    const insertMembership = db.prepare(
      `INSERT INTO message_embedding_chunk_messages (
         chunk_id, chat_id, message_id, position
       )
       VALUES (?, ?, ?, ?)`,
    );
    const changedSinceSnapshot = db.prepare(
      `SELECT EXISTS (
         SELECT 1
         FROM messages
         WHERE chat_id = ?
           AND message_id BETWEEN ? AND ?
           AND julianday(updated_at) >= julianday(?)
       ) AS changed`,
    );
    const markChunkDirty = db.prepare(
      `UPDATE message_embedding_chunks
       SET dirty_at = COALESCE(dirty_at, datetime('now')),
           updated_at = datetime('now')
       WHERE id = ?`,
    );

    for (const chunk of chunks) {
      const chunkId = safePositiveInteger(chunk.id, "chunk id");
      const startMessageId = safePositiveInteger(
        chunk.start_message_id,
        "chunk start_message_id",
      );
      const endMessageId = safePositiveInteger(
        chunk.end_message_id,
        "chunk end_message_id",
      );
      if (endMessageId < startMessageId) {
        throw new Error(
          `Embedding chunk ${chunkId} has an inverted range.`,
        );
      }
      const messageCount = safePositiveInteger(
        chunk.message_count,
        "chunk message_count",
        MAX_EMBEDDING_CHUNK_MESSAGE_COUNT,
      );
      const chatId = String(chunk.chat_id ?? "");
      if (!chatId) {
        throw new Error(
          `Embedding chunk ${chunkId} has an empty chat id.`,
        );
      }
      const messages = selectMessages.all(
        chatId,
        startMessageId,
        endMessageId,
        messageCount,
      ) as Array<Record<string, unknown>>;
      deleteMembership.run(chunkId);
      for (const [position, message] of messages.entries()) {
        insertMembership.run(
          chunkId,
          chatId,
          safePositiveInteger(
            message.message_id,
            "membership message_id",
          ),
          position,
        );
      }
      const sourceChanged = changedSinceSnapshot.get(
        chatId,
        startMessageId,
        endMessageId,
        sourceSnapshotAt,
      ) as Record<string, unknown> | undefined;
      if (sourceChanged?.changed === 1) {
        // Live edits could not dirty a historical chunk before membership
        // existed, so only rows changed after the snapshot are dirtied.
        markChunkDirty.run(chunkId);
      }
    }

    const nextLastChunkId =
      chunks.length > 0
        ? safePositiveInteger(
            chunks[chunks.length - 1]?.id,
            "last chunk id",
          )
        : targetMaxChunkId;
    const remainingRows = countRemainingEmbeddingChunks(
      db,
      nextLastChunkId,
      targetMaxChunkId,
    );
    const processedChunks =
      (progressInteger(job.details.processedChunks) ?? 0) +
      chunks.length;
    const nextDetails = {
      ...job.details,
      targetMaxChunkId,
      lastChunkId: nextLastChunkId,
      processedChunks,
      sourceSnapshotAt,
      batchSize,
      remainingChunks: remainingRows,
    };
    if (remainingRows === 0) {
      completeMaintenanceJob(db, job, nextDetails);
    } else {
      updatePendingMaintenanceJob(db, job, nextDetails);
    }
    return {
      status:
        remainingRows === 0 ? "completed" : "pending",
      ran: true,
      processedRows: chunks.length,
      remainingRows,
    };
  });
}

function maxEmbeddingChunkId(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(id), 0) AS max_chunk_id
       FROM message_embedding_chunks`,
    )
    .get() as Record<string, unknown>;
  return progressInteger(row.max_chunk_id) ?? 0;
}

function countRemainingEmbeddingChunks(
  db: DatabaseSync,
  lastChunkId: number,
  targetMaxChunkId: number,
): number {
  return scalarCount(
    db,
    `SELECT count(*) AS count
     FROM message_embedding_chunks
     WHERE id > ? AND id <= ?`,
    lastChunkId,
    targetMaxChunkId,
  );
}
