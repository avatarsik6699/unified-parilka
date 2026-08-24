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

const EDIT_IMAGE_TOOL_DESCRIPTION =
  "Перерисовывает через Runware картинку, на которую отвечено (реплай) или " +
  "которая приложена к текущему сообщению, и прикладывает результат к " +
  "ответу как настоящее Telegram-фото — не как ссылку в тексте. Никогда не " +
  "вставляй URL или id результата в текст ответа. Текст описания правки НЕ " +
  "передаётся через параметры этого инструмента — он берётся дословно из " +
  "исходного сообщения пользователя автоматически. Твоя роль — только " +
  "решить, вызывать ли инструмент. Доступен только когда в этот ход уже " +
  "есть распознанная исходная картинка. Лимит — не больше одной картинки " +
  "за ответ.";

/**
 * Registers `edit_image` only when both a Runware client and this turn's
 * already-downloaded reference photo are present -- absent from the model's
 * tool list entirely (not just refusing at call time) otherwise. Reuses the
 * same image budget as `generate_image`: both are Runware image spend.
 */
export function addEditImageTool(
  existing: ToolSet,
  options: WebToolSetOptions,
  addedNames: string[],
): void {
  const { port } = options;
  if (port.runwareClient === undefined || port.referenceImage === undefined) {
    return;
  }
  const runwareClient = port.runwareClient;
  const referenceImage = port.referenceImage;
  const imageBudget = port.imageBudget;
  existing.edit_image = tool({
    description: EDIT_IMAGE_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<Record<string, unknown>>(
      objectSchema({}, []) as Record<string, unknown>,
    ),
    execute: async (_input, execution) => {
      const startedAt = Date.now();
      options.onExecutionStarted?.({
        name: "edit_image",
        callId: execution.toolCallId,
        input: {},
      });
      const reservation = imageBudget?.reserve(port.turnId) ?? { ok: true };
      if (!reservation.ok) {
        const failure: WebToolResult = {
          ok: false,
          tool: "edit_image",
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
          name: "edit_image",
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
          tool: "edit_image",
          error: {
            code: "invalid_arguments",
            message: "No source text available to describe the edit.",
          },
          evidence: [],
        };
        options.onExecutionCompleted?.({
          name: "edit_image",
          callId: execution.toolCallId,
          startedAt,
          output: failure,
        });
        return failure;
      }
      try {
        const translation = await port.translateImagePrompt?.(
          rawPrompt,
          execution.abortSignal ?? port.turnSignal,
        );
        const prompt = translation?.ok === true ? translation.text : rawPrompt;
        const dataUri = `data:${referenceImage.mediaType};base64,${Buffer.from(referenceImage.data).toString("base64")}`;
        const result = await runwareClient.generate(
          { prompt, referenceImages: [dataUri] },
          execution.abortSignal ?? port.turnSignal,
        );
        if (!result.ok) {
          imageBudget?.release(port.turnId);
          const failure: WebToolResult = {
            ok: false,
            tool: "edit_image",
            error: result.error,
            evidence: [],
          };
          options.onExecutionCompleted?.({
            name: "edit_image",
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
          tool: "edit_image",
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
          name: "edit_image",
          callId: execution.toolCallId,
          startedAt,
          output,
        });
        return output;
      } catch {
        imageBudget?.release(port.turnId);
        return failTyped(
          options,
          "edit_image",
          execution.toolCallId,
          startedAt,
        );
      }
    },
    toModelOutput: ({ output }) => ({
      type: "text" as const,
      value: wrapUntrustedToolData(
        "edit_image",
        boundedSerialize(output, maxCarriedToolResultChars("edit_image")),
        port.nonce,
      ),
    }),
  });
  addedNames.push("edit_image");
}
