import type {
  ModelExecutionResult,
  ModelRole,
  ResolvedModelCandidate,
} from "../providers/model-router.js";

export const NEWS_BRIEF_TIME_ZONE = "Europe/Moscow";
export const DEFAULT_NEWS_BRIEF_TOPICS = [
  "биохакинг новости",
  "лонгевити исследование",
  "нутрициология исследование",
  "medicine research breakthrough",
  "biohacking longevity study",
] as const;
export const DEFAULT_MAX_ITEMS = 6;
export const MAX_ITEMS_CEILING = 10;
export const MAX_ENRICH_ITEMS = 5;
export const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Headroom under Telegram's 4096-char message limit.
export const MAX_MESSAGE_CHARS = 3_800;

export interface NewsBriefSourceItem {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  articleText?: string;
}

/** Narrow router surface this domain depends on -- mirrors DigestModelRouter's shape. */
export interface NewsBriefModelRouter {
  executeWithFallback<T>(
    role: ModelRole,
    attempt: (
      candidate: ResolvedModelCandidate,
      attemptNumber: number,
    ) => Promise<T>,
  ): Promise<ModelExecutionResult<T>>;
}

export interface NewsBriefSummaryResult {
  text: string;
  model: string;
  providerId: string;
  inputTokens?: number;
  outputTokens?: number;
  fallbackCount?: number;
}

export interface NewsBriefSummaryRequest {
  items: NewsBriefSourceItem[];
  maxOutputChars: number;
  signal: AbortSignal;
}

export interface NewsBriefSummaryPort {
  summarize(request: NewsBriefSummaryRequest): Promise<NewsBriefSummaryResult>;
}

export type NewsBriefSendOutcome = "sent" | "duplicate" | "skipped_dry_run";

export interface NewsBriefSendResult {
  outcome: NewsBriefSendOutcome;
  telegramMessageId?: number;
}

export interface NewsBriefRunReport {
  mode: "dry_run" | "applied";
  chatId: string;
  timeZone: typeof NEWS_BRIEF_TIME_ZONE;
  startedAt: string;
  finishedAt: string;
  collected: number;
  enriched: number;
  selected: Array<{ title: string; url: string }>;
  summary?: {
    chars: number;
    model: string;
    providerId: string;
    fallbackCount?: number;
  };
  send?: NewsBriefSendResult;
  status: "ok" | "empty";
}
