import { jsonSchema, tool, type ToolSet } from "ai";
import { wrapUntrustedToolData } from "../prompt.js";
import {
  boundedSerialize,
  maxCarriedToolResultChars,
} from "../agent/evidence.js";
import {
  failTyped,
  objectSchema,
  type WebToolResult,
  type WebToolSetOptions,
} from "./tool-definitions.js";

function generateImageToolDescription(nsfwAllowed: boolean): string {
  return (
    "Генерирует новую картинку через Runware и прикладывает её к ответу как " +
    "настоящее Telegram-фото — не как ссылку в тексте. Никогда не вставляй " +
    "URL или id результата в текст ответа: картинка доставляется отдельно. " +
    "Текст описания картинки НЕ передаётся через параметры этого " +
    "инструмента — он берётся дословно из исходного сообщения пользователя " +
    "автоматически, без переписывания и смягчения. Твоя роль — только " +
    "решить, вызывать ли инструмент, и задать технические параметры " +
    "(размер, nsfw). " +
    (nsfwAllowed
      ? "NSFW-контент разрешён оператором для этого чата: параметр nsfw " +
        "можно ставить true, когда это уместно."
      : "NSFW отключён оператором для этого чата: параметр nsfw " +
        "игнорируется, генерация всегда идёт в безопасном режиме.") +
    " Лимит — не больше одной картинки за ответ."
  );
}

/**
 * Registers `generate_image` only when the port carries a configured
 * Runware client -- absent from the model's tool list entirely (not just
 * refusing at call time) when the feature is disabled.
 */
export function addGenerateImageTool(
  existing: ToolSet,
  options: WebToolSetOptions,
  addedNames: string[],
): void {
  const { port } = options;
  if (port.runwareClient === undefined) {
    return;
  }
  const runwareClient = port.runwareClient;
  const imageBudget = port.imageBudget;
  const nsfwAllowed = port.nsfwAllowed === true;
  existing.generate_image = tool({
    description: generateImageToolDescription(nsfwAllowed),
    inputSchema: jsonSchema<Record<string, unknown>>(
      objectSchema(
        {
          width: {
            type: "integer",
            enum: [512, 768, 1024],
            description: "Ширина в пикселях, по умолчанию 512.",
          },
          height: {
            type: "integer",
            enum: [512, 768, 1024],
            description: "Высота в пикселях, по умолчанию 512.",
          },
          nsfw: {
            type: "boolean",
            description: nsfwAllowed
              ? "true — снять safety-фильтр для этой генерации."
              : "Игнорируется: NSFW отключён оператором для этого чата.",
          },
        },
        [],
      ) as Parameters<typeof jsonSchema>[0],
    ),
    execute: async (input, execution) => {
      const startedAt = Date.now();
      options.onExecutionStarted?.({
        name: "generate_image",
        callId: execution.toolCallId,
        input,
      });
      const reservation = imageBudget?.reserve(port.turnId) ?? { ok: true };
      if (!reservation.ok) {
        const failure: WebToolResult = {
          ok: false,
          tool: "generate_image",
          error: {
            code:
              reservation.code === "day_limit"
                ? "budget_exceeded_day"
                : "budget_exceeded_turn",
            message:
              reservation.code === "day_limit"
                ? "Дневной лимит генерации картинок для этого чата исчерпан."
                : "Лимит генерации картинок на этот ответ исчерпан.",
          },
          evidence: [],
        };
        options.onExecutionCompleted?.({
          name: "generate_image",
          callId: execution.toolCallId,
          startedAt,
          output: failure,
        });
        return failure;
      }
      const rawPrompt = port.rawImagePromptSource ?? "";
      if (rawPrompt.length === 0) {
        imageBudget?.release(port.turnId);
        const failure: WebToolResult = {
          ok: false,
          tool: "generate_image",
          error: {
            code: "invalid_arguments",
            message: "No source text available to generate an image from.",
          },
          evidence: [],
        };
        options.onExecutionCompleted?.({
          name: "generate_image",
          callId: execution.toolCallId,
          startedAt,
          output: failure,
        });
        return failure;
      }
      try {
        const result = await runwareClient.generate(
          {
            prompt: rawPrompt,
            width: typeof input.width === "number" ? input.width : undefined,
            height: typeof input.height === "number" ? input.height : undefined,
            nsfw: input.nsfw === true,
          },
          execution.abortSignal ?? port.turnSignal,
        );
        if (!result.ok) {
          imageBudget?.release(port.turnId);
          const failure: WebToolResult = {
            ok: false,
            tool: "generate_image",
            error: result.error,
            evidence: [],
          };
          options.onExecutionCompleted?.({
            name: "generate_image",
            callId: execution.toolCallId,
            startedAt,
            output: failure,
          });
          return failure;
        }
        imageBudget?.commit(port.turnId);
        port.onImageGenerated?.({
          bytes: result.imageBytes,
          model: result.model,
          width: result.width,
          height: result.height,
        });
        const output: WebToolResult = {
          ok: true,
          tool: "generate_image",
          status: "done",
          result: {
            model: result.model,
            width: result.width,
            height: result.height,
            note:
              "Картинка уже прикреплена к твоему ответу как фото. Не " +
              "вставляй ссылку или id в текст ответа.",
          },
          evidence: [],
        };
        options.onExecutionCompleted?.({
          name: "generate_image",
          callId: execution.toolCallId,
          startedAt,
          output,
        });
        return output;
      } catch {
        imageBudget?.release(port.turnId);
        return failTyped(
          options,
          "generate_image",
          execution.toolCallId,
          startedAt,
        );
      }
    },
    toModelOutput: ({ output }) => ({
      type: "text" as const,
      value: wrapUntrustedToolData(
        "generate_image",
        boundedSerialize(output, maxCarriedToolResultChars("generate_image")),
        port.nonce,
      ),
    }),
  });
  addedNames.push("generate_image");
}
