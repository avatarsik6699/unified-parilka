import { jsonSchema, tool, type ToolSet } from "ai";
import { wrapUntrustedToolData } from "../prompt.js";
import {
  boundedSerialize,
  maxCarriedToolResultChars,
} from "../agent/evidence.js";
import { RUNWARE_TTS_RU_VOICES } from "./runware-client.js";
import {
  failTyped,
  objectSchema,
  type WebToolResult,
  type WebToolSetOptions,
} from "./tool-definitions.js";

const SPEAK_TEXT_TOOL_DESCRIPTION =
  "Озвучивает короткий русский текст (до 2000 символов) через Runware и " +
  "прикладывает результат к ответу как настоящее голосовое сообщение " +
  "Telegram вместо обычного текста. Используй только когда пользователь " +
  "прямо просит голосовой ответ, а не как обычный способ отвечать. Из-за " +
  "ограничений Telegram голосовое сообщение несёт только этот текст как " +
  "подпись — остальной текст ответа отдельно показан не будет, так что " +
  "передавай сюда именно то, что должно прозвучать. Лимит — один голосовой " +
  "ответ за ход.";

/**
 * Registers `speak_text` only when the port carries a configured TTS
 * client -- absent from the model's tool list entirely when the feature is
 * disabled, matching `generate_image`'s conditional-registration pattern.
 */
export function addSpeakTextTool(
  existing: ToolSet,
  options: WebToolSetOptions,
  addedNames: string[],
): void {
  const { port } = options;
  if (port.ttsClient === undefined) {
    return;
  }
  const ttsClient = port.ttsClient;
  const ttsBudget = port.ttsBudget;
  existing.speak_text = tool({
    description: SPEAK_TEXT_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<Record<string, unknown>>(
      objectSchema(
        {
          text: {
            type: "string",
            minLength: 2,
            maxLength: 2_000,
            description: "Текст на русском, который нужно озвучить.",
          },
          voice: {
            type: "string",
            enum: [...RUNWARE_TTS_RU_VOICES],
            description: `Голос, по умолчанию ${RUNWARE_TTS_RU_VOICES[0]}.`,
          },
        },
        ["text"],
      ) as Parameters<typeof jsonSchema>[0],
    ),
    execute: async (input, execution) => {
      const startedAt = Date.now();
      options.onExecutionStarted?.({
        name: "speak_text",
        callId: execution.toolCallId,
        input,
      });
      const reservation = ttsBudget?.reserve(port.turnId) ?? { ok: true };
      if (!reservation.ok) {
        const failure: WebToolResult = {
          ok: false,
          tool: "speak_text",
          error: {
            code:
              reservation.code === "day_limit"
                ? "budget_exceeded_day"
                : "budget_exceeded_turn",
            message:
              reservation.code === "day_limit"
                ? "Дневной лимит голосовых ответов для этого чата исчерпан."
                : "Лимит голосовых ответов на этот ход исчерпан.",
          },
          evidence: [],
        };
        options.onExecutionCompleted?.({
          name: "speak_text",
          callId: execution.toolCallId,
          startedAt,
          output: failure,
        });
        return failure;
      }
      try {
        const result = await ttsClient.synthesizeSpeech(
          {
            text: String(input.text ?? ""),
            voice: typeof input.voice === "string" ? input.voice : undefined,
          },
          execution.abortSignal ?? port.turnSignal,
        );
        if (!result.ok) {
          ttsBudget?.release(port.turnId);
          const failure: WebToolResult = {
            ok: false,
            tool: "speak_text",
            error: result.error,
            evidence: [],
          };
          options.onExecutionCompleted?.({
            name: "speak_text",
            callId: execution.toolCallId,
            startedAt,
            output: failure,
          });
          return failure;
        }
        ttsBudget?.commit(port.turnId);
        port.onSpeechGenerated?.({
          bytes: result.audioBytes,
          model: result.model,
          voice: result.voice,
        });
        const output: WebToolResult = {
          ok: true,
          tool: "speak_text",
          status: "done",
          result: {
            model: result.model,
            voice: result.voice,
            note:
              "Голосовое сообщение уже прикреплено к твоему ответу. Не " +
              "вставляй ссылку или id в текст ответа.",
          },
          evidence: [],
        };
        options.onExecutionCompleted?.({
          name: "speak_text",
          callId: execution.toolCallId,
          startedAt,
          output,
        });
        return output;
      } catch {
        ttsBudget?.release(port.turnId);
        return failTyped(
          options,
          "speak_text",
          execution.toolCallId,
          startedAt,
        );
      }
    },
    toModelOutput: ({ output }) => ({
      type: "text" as const,
      value: wrapUntrustedToolData(
        "speak_text",
        boundedSerialize(output, maxCarriedToolResultChars("speak_text")),
        port.nonce,
      ),
    }),
  });
  addedNames.push("speak_text");
}
