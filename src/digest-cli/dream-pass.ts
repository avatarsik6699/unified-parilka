import type { DigestModelRouter } from "../digests.js";
import { DreamConsolidator } from "../dream/consolidator.js";
import type { MessageStore } from "../store.js";
import type { CliOptions } from "./options.js";

export type DreamPassResult =
  | {
      status: "skipped";
      reason: "dry_run" | "no_model_config";
      pendingCount: number;
    }
  | {
      status: "no_new_messages";
      pendingCount: number;
    }
  | {
      status: "failed";
      error: string;
      preservedRevision: number;
    }
  | {
      status: "success";
      revision: number;
      chars: number;
      messageCount: number;
      newWatermark: number;
      model: string;
      providerId: string;
      fallbackCount: number;
    };

export interface DreamPassOptions
  extends Pick<
    CliOptions,
    | "chatId"
    | "apply"
    | "dreamEveryNMessages"
    | "dreamMaxMessages"
    | "memoryMaxChars"
    | "modelConfigPath"
    | "modelTotalTimeoutMs"
    | "modelCandidateTimeoutMs"
  > {}

export async function runDreamPass(
  store: MessageStore,
  options: DreamPassOptions,
  router: DigestModelRouter | undefined,
): Promise<DreamPassResult> {
  const current = store.getChatMemory(options.chatId);
  const pendingCount = store.countMessagesSince({
    chatId: options.chatId,
    messageId: current?.lastConsolidatedMessageId,
  });

  if (!options.apply || router === undefined) {
    return {
      status: "skipped",
      reason: options.apply ? "no_model_config" : "dry_run",
      pendingCount,
    };
  }

  if (pendingCount < options.dreamEveryNMessages) {
    return { status: "no_new_messages", pendingCount };
  }

  const consolidator = new DreamConsolidator({
    router,
    maxOutputChars: options.memoryMaxChars,
    totalTimeoutMs: options.modelTotalTimeoutMs,
    candidateTimeoutMs: options.modelCandidateTimeoutMs,
  });

  const result = await consolidator.run(store, {
    chatId: options.chatId,
    threshold: options.dreamEveryNMessages,
    maxMessages: options.dreamMaxMessages,
  });

  if (result.status === "no_new_messages") {
    return { status: "no_new_messages", pendingCount };
  }

  if (result.status === "failed") {
    return {
      status: "failed",
      error: result.error,
      preservedRevision: result.preservedRevision,
    };
  }

  return {
    status: "success",
    revision: result.revision,
    chars: result.chars,
    messageCount: result.messageCount,
    newWatermark: result.newWatermark,
    model: result.model,
    providerId: result.providerId,
    fallbackCount: result.fallbackCount,
  };
}
