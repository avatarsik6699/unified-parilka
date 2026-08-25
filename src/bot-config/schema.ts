import { z } from "zod";

/**
 * One JSON file (`BOT_BOTS_CONFIG_PATH`) lists every bot this deployment
 * runs, regardless of which process ends up serving it: `bot-agi-bot`
 * filters for `role: "assistant"`, `bot-agi-sync` filters for
 * `role: "human-persona"` (ADR 0007). Free-form prose (assistant persona
 * text) still lives in its own file, referenced by path -- multi-paragraph
 * text in a JSON string needs escaping a real editor doesn't (Фаза 6).
 */

const assistantCuriosityTriggerSchema = z
  .object({
    enabled: z.boolean(),
    /** Moscow local hour, inclusive. */
    activeHourStart: z.number().int().min(0).max(23).optional(),
    /** Moscow local hour, exclusive. */
    activeHourEnd: z.number().int().min(1).max(24).optional(),
    minSilenceMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60_000)
      .optional(),
    minSilenceSinceOwnQuestionMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60_000)
      .optional(),
    maxInitiationsPerWindow: z.number().int().min(0).max(1_000).optional(),
    windowMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60_000)
      .optional(),
    pendingAnswerGraceMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60_000)
      .optional(),
    idleIntervalMs: z
      .number()
      .int()
      .min(10_000)
      .max(6 * 60 * 60_000)
      .optional(),
    /** Floor probability of reaching the LLM decision on any given check. */
    baseAskProbability: z.number().min(0).max(1).optional(),
    /** Ceiling probability of reaching the LLM decision on any given check. */
    maxAskProbability: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.baseAskProbability === undefined ||
      value.maxAskProbability === undefined ||
      value.baseAskProbability <= value.maxAskProbability,
    { message: "baseAskProbability must be <= maxAskProbability" },
  );

const assistantBotDefinitionSchema = z
  .object({
    role: z.literal("assistant"),
    chatId: z.string(),
    chatTitle: z.string(),
    personaPromptPath: z.string(),
    approximateMemberCount: z.number().int().positive().optional(),
    /** Off unless explicitly enabled -- see AGENTS.md's assistant curiosity trigger note. */
    curiosityTrigger: assistantCuriosityTriggerSchema.optional(),
  })
  .strict();

const humanPersonaBotDefinitionSchema = z
  .object({
    role: z.literal("human-persona"),
    personaId: z.string(),
    chatId: z.string(),
    chatTitle: z.string(),
    targetUserKey: z.string(),
    approvalChatId: z.string(),
    autonomyMode: z.enum(["approval", "auto"]).optional(),
    /** Moscow local hour, inclusive. */
    activeHourStart: z.number().int().min(0).max(23).optional(),
    /** Moscow local hour, exclusive. */
    activeHourEnd: z.number().int().min(1).max(24).optional(),
    minSilenceMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60_000)
      .optional(),
    maxInitiationsPerWindow: z.number().int().min(0).max(1_000).optional(),
    windowMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60_000)
      .optional(),
  })
  .strict();

export const botDefinitionSchema = z.discriminatedUnion("role", [
  assistantBotDefinitionSchema,
  humanPersonaBotDefinitionSchema,
]);

export const botDefinitionsFileSchema = z.array(botDefinitionSchema);

export type AssistantBotDefinitionEntry = z.infer<
  typeof assistantBotDefinitionSchema
>;
export type HumanPersonaBotDefinitionEntry = z.infer<
  typeof humanPersonaBotDefinitionSchema
>;
export type BotDefinitionEntry = z.infer<typeof botDefinitionSchema>;
