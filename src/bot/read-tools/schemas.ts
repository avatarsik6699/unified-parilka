import { z } from "zod";
import { isCalendarDay } from "./calendar.js";

const querySchema = z.string().trim().min(1).max(500);
const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.")
  .refine(isCalendarDay, "Expected a real Gregorian calendar date.");

export const searchChatArgsSchema = z
  .object({
    query: querySchema,
    limit: z.number().int().min(1).max(8).default(5),
  })
  .strict();

export const dayDigestArgsSchema = z
  .object({
    day_from: calendarDaySchema,
    day_to: calendarDaySchema.optional(),
  })
  .strict();

export const threadContextArgsSchema = z
  .object({
    message_id: z.number().int().positive().safe(),
    before: z.number().int().min(0).max(30).default(8),
    after: z.number().int().min(0).max(30).default(8),
  })
  .strict();

export const webSearchArgsSchema = z
  .object({ query: querySchema })
  .strict();

export const webSearchResponseSchema = z
  .object({
    text: z.string().trim().max(8_000),
    sources: z
      .array(
        z
          .object({
            url: z
              .url()
              .refine(
                (value) =>
                  value.startsWith("https://") ||
                  value.startsWith("http://"),
                "Expected an HTTP(S) URL.",
              ),
            title: z.string().max(500).optional(),
            snippet: z.string().max(4_000).optional(),
            publishedAt: z.string().max(100).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const paperSearchArgsSchema = z
  .object({
    query: querySchema,
    source: z.enum(["arxiv", "europepmc"]).default("arxiv"),
    max_results: z.number().int().min(1).max(5).default(3),
  })
  .strict();

export const paperSearchResponseSchema = z
  .object({
    query: z.string().min(1).max(500),
    source: z.enum(["arxiv", "europepmc"]),
    papers: z
      .array(
        z
          .object({
            title: z.string().max(500),
            authors: z.array(z.string().max(200)).max(50),
            year: z.string().max(20).optional(),
            abstract: z.string().max(8_000).optional(),
            url: z
              .url()
              .refine(
                (value) =>
                  value.startsWith("https://") ||
                  value.startsWith("http://"),
                "Expected an HTTP(S) URL.",
              ),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

export type SearchChatArgs = z.infer<typeof searchChatArgsSchema>;
export type DayDigestArgs = z.infer<typeof dayDigestArgsSchema>;
export type ThreadContextArgs = z.infer<
  typeof threadContextArgsSchema
>;
export type WebSearchArgs = z.infer<typeof webSearchArgsSchema>;
export type PaperSearchArgs = z.infer<typeof paperSearchArgsSchema>;
