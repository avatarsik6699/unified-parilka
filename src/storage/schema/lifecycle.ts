import { StoreCore } from "../core.js";
import { SCHEMA_VERSION } from "../constants.js";
import type { MessageStoreOptions } from "../types.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class SchemaLifecycleMethods extends StoreCore {
  protected initializeStore(options: MessageStoreOptions): void {
    if (options.readOnly === true) {
      this.db.exec("PRAGMA query_only = ON;");
      const currentVersion = this.getSchemaVersion();
      if (currentVersion !== SCHEMA_VERSION) {
        throw new Error(
          `Read-only database schema version ${currentVersion} does not match supported version ${SCHEMA_VERSION}.`,
        );
      }
      this.validateSchema();
      return;
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    // Bot update ACKs and the pre-send `sending` fence are correctness
    // records, not rebuildable cache. FULL keeps a successful COMMIT durable
    // across an OS/power loss before Telegram state advances.
    this.db.exec("PRAGMA synchronous = FULL;");
    this.migrate();
  }

declare protected applyBackfillExhaustedMigration: () => void;
  declare protected applyBaseSchema: () => void;
  declare protected applyBotDurabilityMigration: () => void;
  declare protected applyBotRetryBackoffMigration: () => void;
  declare protected applyBotToolProgressMigration: () => void;
  declare protected applyChatAliasMigration: () => void;
  declare protected applyDaemonStatusMigration: () => void;
  declare protected applyDigestCacheMigration: () => void;
  declare protected applyDigestQueryIndex: () => void;
  declare protected applyEmbeddingChunkMembershipMigration: () => void;
  declare protected applyEmbeddingNamespaceMigration: () => void;
  declare protected applyManagedSqlObjectVersionMigration: () => void;
  declare protected applyMessageReconciliationMigration: () => void;
  declare protected applyRecentCatchupMigration: () => void;
  declare protected applySendOutboxMigration: () => void;
  declare protected assertColumns: (table: string, columns: string[]) => void;
  declare protected assertSqliteObject: (
    type: "table" | "index" | "trigger",
    name: string,
  ) => void;
  declare protected rebuildMessagesFts: () => void;

  protected migrate(): void {
    this.immediateTransaction("migrate", () => {
      const currentVersion = this.getSchemaVersion();
      if (currentVersion > SCHEMA_VERSION) {
        throw new Error(`Database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}.`);
      }
      if (currentVersion < 1) {
        this.applyBaseSchema();
        this.rebuildMessagesFts();
        this.db.exec("PRAGMA user_version = 1");
      }
      if (currentVersion < 2) {
        this.applyBackfillExhaustedMigration();
        this.db.exec("PRAGMA user_version = 2");
      }
      if (currentVersion < 3) {
        this.applyChatAliasMigration();
        this.db.exec("PRAGMA user_version = 3");
      }
      if (currentVersion < 4) {
        this.applyMessageReconciliationMigration();
        this.db.exec("PRAGMA user_version = 4");
      }
      if (currentVersion < 5) {
        this.applyDaemonStatusMigration();
        this.db.exec("PRAGMA user_version = 5");
      }
      if (currentVersion < 6) {
        this.applyEmbeddingChunkMembershipMigration();
        this.db.exec("PRAGMA user_version = 6");
      }
      if (currentVersion < 7) {
        this.applySendOutboxMigration();
        this.db.exec("PRAGMA user_version = 7");
      }
      if (currentVersion < 8) {
        this.applyRecentCatchupMigration();
        this.db.exec("PRAGMA user_version = 8");
      }
      if (currentVersion < 9) {
        this.applyEmbeddingNamespaceMigration();
        this.db.exec("PRAGMA user_version = 9");
      }
      if (currentVersion < 10) {
        this.applyManagedSqlObjectVersionMigration();
        this.db.exec("PRAGMA user_version = 10");
      }
      if (currentVersion < 11) {
        this.applyBotDurabilityMigration();
        this.db.exec("PRAGMA user_version = 11");
      }
      if (currentVersion < 12) {
        this.applyDigestCacheMigration();
        this.db.exec("PRAGMA user_version = 12");
      }
      if (currentVersion < 13) {
        this.applyBotRetryBackoffMigration();
        this.db.exec("PRAGMA user_version = 13");
      }
      if (currentVersion < 14) {
        this.applyBotToolProgressMigration();
        this.db.exec("PRAGMA user_version = 14");
      }
      // This is a backwards-compatible performance index, not a data-model
      // change. Reconcile it for every writable v13 open so databases created
      // by an earlier build do not make one full corpus scan per day.
      this.applyDigestQueryIndex();
      this.validateSchema();
    });
  }

  protected validateSchema(): void {
    for (const table of [
      "chats",
      "chat_aliases",
      "messages",
      "sync_state",
      "history_jobs",
      "daemon_status",
      "send_outbox",
      "send_throttle_state",
      "bot_updates",
      "bot_turns",
      "chat_day_digests",
      "chat_digest_rollups",
      "schema_object_versions",
      "maintenance_jobs",
      "message_embedding_chunks",
      "message_embedding_chunk_messages",
      "messages_fts",
    ]) {
      this.assertSqliteObject("table", table);
    }
    for (const index of [
      "idx_messages_chat_message_id",
      "idx_messages_sender",
      "idx_chat_aliases_chat_id",
      "idx_embedding_chunks_lookup",
      "idx_embedding_chunks_range",
      "idx_embedding_chunk_messages_lookup",
      "idx_embedding_chunk_messages_chunk_position",
      "idx_send_outbox_chat_status",
      "idx_send_outbox_user_status",
      "idx_bot_updates_status",
      "idx_bot_turns_claim",
      "idx_bot_turns_chat_status",
      "idx_chat_day_digests_range",
      "idx_chat_digest_rollups_range",
    ]) {
      this.assertSqliteObject("index", index);
    }
    for (const trigger of ["messages_ai", "messages_ad", "messages_au", "embedding_chunks_ad"]) {
      this.assertSqliteObject("trigger", trigger);
    }
    this.assertColumns("messages", ["id", "chat_id", "message_id", "text", "deleted_at", "updated_at"]);
    this.assertColumns("message_embedding_chunks", ["id", "chat_id", "embedding_namespace", "dirty_at", "updated_at"]);
    this.assertColumns("message_embedding_chunk_messages", ["chunk_id", "chat_id", "message_id", "position"]);
    this.assertColumns("send_outbox", [
      "id",
      "dedupe_key",
      "payload_hash",
      "chat_id",
      "reply_to_message_id",
      "user_key",
      "status",
      "telegram_message_id",
      "error",
      "created_at_ms",
      "updated_at_ms",
      "queued_at_ms",
      "sending_at_ms",
      "sent_at_ms",
      "expires_at_ms",
    ]);
    this.assertColumns("send_throttle_state", ["chat_id", "user_key", "next_allowed_at_ms", "updated_at_ms"]);
    this.assertColumns("bot_updates", [
      "update_id",
      "raw_json",
      "status",
      "addressed",
      "chat_id",
      "trigger_message_id",
      "attempts",
      "max_attempts",
      "error",
      "received_at_ms",
      "updated_at_ms",
      "completed_at_ms",
    ]);
    this.assertColumns("bot_turns", [
      "id",
      "update_id",
      "chat_id",
      "trigger_message_id",
      "status",
      "attempts",
      "max_attempts",
      "lease_owner",
      "lease_expires_at_ms",
      "retry_not_before_ms",
      "draft_text",
      "telegram_message_id",
      "progress_message_id",
      "progress_state",
      "error",
      "created_at_ms",
      "updated_at_ms",
      "started_at_ms",
      "completed_at_ms",
    ]);
    this.assertColumns("chat_day_digests", [
      "chat_id",
      "day",
      "start_message_id",
      "end_message_id",
      "message_count",
      "text",
      "prompt_version",
      "model",
      "input_tokens",
      "output_tokens",
      "source_hash",
      "created_at_ms",
      "updated_at_ms",
    ]);
    this.assertColumns("chat_digest_rollups", [
      "chat_id",
      "kind",
      "period",
      "day_from",
      "day_to",
      "day_count",
      "text",
      "prompt_version",
      "model",
      "input_tokens",
      "output_tokens",
      "source_hash",
      "created_at_ms",
      "updated_at_ms",
    ]);
    this.assertColumns("daemon_status", [
      "service",
      "last_started_at",
      "last_success_at",
      "last_failure_at",
      "last_error",
      "consecutive_failures",
      "updated_at",
    ]);
    this.assertColumns("schema_object_versions", [
      "object_name",
      "object_type",
      "object_version",
      "object_hash",
      "updated_at",
    ]);
    this.assertColumns("maintenance_jobs", [
      "name",
      "status",
      "reason",
      "details_json",
      "updated_at",
      "completed_at",
    ]);
    this.assertColumns("sync_state", [
      "chat_id",
      "oldest_message_id",
      "newest_message_id",
      "next_backfill_offset_id",
      "recent_catchup_min_id",
      "recent_catchup_next_offset_id",
      "recent_catchup_newest_id",
      "synced_count",
      "last_recent_sync_at",
      "last_backfill_at",
      "backfill_exhausted_at",
      "last_error",
      "updated_at",
    ]);
    this.db.prepare("SELECT rowid FROM messages_fts LIMIT 1").all();
  }
}
