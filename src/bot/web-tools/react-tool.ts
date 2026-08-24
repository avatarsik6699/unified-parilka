import { jsonSchema, tool, type ToolSet } from "ai";
import { wrapUntrustedToolData } from "../prompt.js";
import {
  boundedSerialize,
  maxCarriedToolResultChars,
} from "../agent/evidence.js";
import { TELEGRAM_REACTION_EMOJI } from "./reaction-contracts.js";
import type { TelegramReactionEmoji } from "./reaction-contracts.js";
import {
  failTyped,
  objectSchema,
  type WebToolResult,
  type WebToolSetOptions,
} from "./tool-definitions.js";

const REACT_TOOL_DESCRIPTION =
  "Ставит emoji-реакцию на сообщение через нативный Telegram-механизм " +
  "реакций — не отдельное сообщение в чате. Используй как лёгкий отклик " +
  "(согласие, смех, одобрение) вместо текстового ответа, когда полноценный " +
  "текстовый ответ не нужен. Параметр target ОБЯЗАТЕЛЬНО выбирай по смыслу " +
  "просьбы, не оставляй по умолчанию не думая: если пользователь сам " +
  "ответил (реплаем) на чужое сообщение и просит поставить реакцию на " +
  "«это», «то сообщение» или прямо на тот реплай — используй target=reply, " +
  "иначе реакция уйдёт не на то сообщение. target=trigger используй, " +
  "только если реакция явно про само обращение к тебе, а не про то, на " +
  "что оно отвечало. Лимит — одна реакция за ответ.";

/**
 * Registers `react_to_message` only when the port carries a live reaction
 * Bot API port for this turn -- absent from the model's tool list entirely
 * when the worker has none wired, matching `generate_image`'s pattern.
 */
export function addReactToMessageTool(
  existing: ToolSet,
  options: WebToolSetOptions,
  addedNames: string[],
): void {
  const { port } = options;
  if (port.reaction === undefined) {
    return;
  }
  const reaction = port.reaction;
  existing.react_to_message = tool({
    description: REACT_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<Record<string, unknown>>(
      objectSchema(
        {
          emoji: {
            type: "string",
            enum: [...TELEGRAM_REACTION_EMOJI],
            description: "Одна из поддерживаемых Telegram эмодзи-реакций.",
          },
          target: {
            type: "string",
            enum: ["trigger", "reply"],
            description:
              "trigger (по умолчанию) — само сообщение, которое к тебе " +
              "обратилось; reply — то сообщение, на которое ОНО САМО " +
              "отвечало реплаем. Пример: юзер реплаит чужое сообщение и " +
              "пишет «поставь на это 🔥» — верный выбор здесь reply, а не " +
              "trigger.",
          },
        },
        ["emoji"],
      ) as Parameters<typeof jsonSchema>[0],
    ),
    execute: async (input, execution) => {
      const startedAt = Date.now();
      options.onExecutionStarted?.({
        name: "react_to_message",
        callId: execution.toolCallId,
        input,
      });
      const emoji = input.emoji;
      if (
        typeof emoji !== "string" ||
        !TELEGRAM_REACTION_EMOJI.includes(emoji as TelegramReactionEmoji)
      ) {
        const failure: WebToolResult = {
          ok: false,
          tool: "react_to_message",
          error: {
            code: "invalid_arguments",
            message: "emoji must be one of the supported reaction emoji.",
          },
          evidence: [],
        };
        options.onExecutionCompleted?.({
          name: "react_to_message",
          callId: execution.toolCallId,
          startedAt,
          output: failure,
        });
        return failure;
      }
      const target = input.target === "reply" ? "reply" : "trigger";
      const messageId =
        target === "reply"
          ? reaction.replyMessageId
          : reaction.triggerMessageId;
      if (messageId === undefined) {
        const failure: WebToolResult = {
          ok: false,
          tool: "react_to_message",
          error: {
            code: "invalid_arguments",
            message: "No reply-target message is available this turn.",
          },
          evidence: [],
        };
        options.onExecutionCompleted?.({
          name: "react_to_message",
          callId: execution.toolCallId,
          startedAt,
          output: failure,
        });
        return failure;
      }
      try {
        const result = await reaction.api.setMessageReaction(
          reaction.chatId,
          messageId,
          emoji as TelegramReactionEmoji,
          execution.abortSignal ?? port.turnSignal,
        );
        const output: WebToolResult = result.ok
          ? {
              ok: true,
              tool: "react_to_message",
              status: "done",
              result: { emoji, target },
              evidence: [],
            }
          : {
              ok: false,
              tool: "react_to_message",
              error: {
                code: "provider_error",
                message: "Telegram rejected the reaction.",
              },
              evidence: [],
            };
        options.onExecutionCompleted?.({
          name: "react_to_message",
          callId: execution.toolCallId,
          startedAt,
          output,
        });
        return output;
      } catch {
        return failTyped(
          options,
          "react_to_message",
          execution.toolCallId,
          startedAt,
        );
      }
    },
    toModelOutput: ({ output }) => ({
      type: "text" as const,
      value: wrapUntrustedToolData(
        "react_to_message",
        boundedSerialize(output, maxCarriedToolResultChars("react_to_message")),
        port.nonce,
      ),
    }),
  });
  addedNames.push("react_to_message");
}
