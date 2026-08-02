import { BotTurnMethods, type BotTurnApi } from "./storage/bot-turns.js";
import { BotUpdateMethods, type BotUpdateApi } from "./storage/bot-updates.js";
import {
  ChatKnowledgeMethods,
  type ChatKnowledgeApi,
} from "./storage/chat-knowledge.js";
import { StoreCore } from "./storage/core.js";
import { DigestMethods, type DigestApi } from "./storage/digests.js";
import { MemoryMethods, type MemoryApi } from "./storage/memory.js";
import { EmbeddingMethods, type EmbeddingApi } from "./storage/embeddings.js";
import { installStoreDomain } from "./storage/install-domain.js";
import { MessageMethods, type MessageApi } from "./storage/messages.js";
import { SchemaDefinitionMethods } from "./storage/schema/definitions.js";
import { SchemaLifecycleMethods } from "./storage/schema/lifecycle.js";
import { SchemaMigrationMethods } from "./storage/schema/migrations.js";
import { SchemaObjectMethods } from "./storage/schema/objects.js";
import {
  SendOutboxMethods,
  type SendOutboxApi,
} from "./storage/send-outbox.js";
import { StatusMethods, type StatusApi } from "./storage/status.js";
import { SyncOpsMethods, type SyncOpsApi } from "./storage/sync-ops.js";
import type { MessageStoreOptions } from "./storage/types.js";

export * from "./storage/message-adapter.js";
export type * from "./storage/types.js";
export {
  MAX_FAST_CHAT_MEMORY_ITEMS,
  MAX_CHAT_LESSONS,
  MAX_CHAT_SKILLS,
  MAX_FAST_TITLE_CHARS,
  MAX_FAST_NOTE_CHARS,
  MAX_LESSON_TITLE_CHARS,
  MAX_LESSON_FIELD_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  MAX_KNOWLEDGE_QUERY_CHARS,
} from "./storage/chat-knowledge.js";

export interface MessageStore
  extends MessageApi,
    BotUpdateApi,
    BotTurnApi,
    DigestApi,
    EmbeddingApi,
    ChatKnowledgeApi,
    MemoryApi,
    SendOutboxApi,
    SyncOpsApi,
    StatusApi {}

/**
 * Stable compatibility facade over domain-focused SQLite method modules.
 *
 * There is exactly one StoreCore and one DatabaseSync per MessageStore.
 * Modules contribute methods to this prototype; they are never instantiated
 * as separate stores and cannot start nested transactions independently.
 */
export class MessageStore extends StoreCore {
  declare private initializeStore: (options: MessageStoreOptions) => void;

  constructor(path: string, options: MessageStoreOptions = {}) {
    super(path, options);
    try {
      this.initializeStore(options);
    } catch (error) {
      this.close();
      throw error;
    }
  }
}

const domains = [
  SchemaDefinitionMethods,
  SchemaMigrationMethods,
  SchemaObjectMethods,
  SchemaLifecycleMethods,
  MessageMethods,
  BotUpdateMethods,
  BotTurnMethods,
  DigestMethods,
  EmbeddingMethods,
  ChatKnowledgeMethods,
  MemoryMethods,
  SendOutboxMethods,
  SyncOpsMethods,
  StatusMethods,
] as const;

for (const domain of domains) {
  installStoreDomain(
    MessageStore.prototype as unknown as Record<PropertyKey, unknown>,
    domain.prototype as unknown as Record<PropertyKey, unknown>,
  );
}
