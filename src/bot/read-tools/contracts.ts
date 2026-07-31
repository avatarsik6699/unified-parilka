import type { StoredMessage } from "../../store.js";

export const BOT_READ_TOOL_NAMES = [
  "search_chat",
  "day_digest",
  "thread_context",
  "web_search",
  "web_fetch",
  "paper_search",
  "research_lookup",
] as const;
export const MAX_BOT_READ_TOOL_OUTPUT_CHARS = 4_000;
export const MAX_PAPER_SEARCH_RESULTS = 5;
export const MAX_WEB_FETCH_TEXT_CHARS = 3_000;

export type BotReadToolName = (typeof BOT_READ_TOOL_NAMES)[number];

export interface BotReadToolDefinition {
  name: BotReadToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The model-facing contracts intentionally retain the Python bot names
 * and argument spelling. This keeps prompts/evals portable while execution is
 * now a direct library call instead of a loop through the bot's own MCP.
 */
export const BOT_READ_TOOL_DEFINITIONS: readonly BotReadToolDefinition[] = [
  {
    name: "search_chat",
    description:
      "Поиск только по локально закэшированной истории этого чата. Используй лишь когда нужен факт из прошлой переписки, решение или высказывание участника; не используй для внешней справки и не вызывай просто потому, что инструмент доступен.",
    inputSchema: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Поисковый запрос своими словами.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "Количество найденных сообщений, по умолчанию 5.",
        },
      },
      ["query"],
    ),
  },
  {
    name: "day_digest",
    description:
      "Сводка только из локального кэша этого чата за календарный день или диапазон дней в часовом поясе Europe/Moscow. Не заменяет внешний поиск.",
    inputSchema: objectSchema(
      {
        day_from: {
          type: "string",
          format: "date",
          description: "Начало диапазона, YYYY-MM-DD.",
        },
        day_to: {
          type: "string",
          format: "date",
          description: "Конец включительного диапазона, YYYY-MM-DD.",
        },
      },
      ["day_from"],
    ),
  },
  {
    name: "thread_context",
    description:
      "Сообщения только из локального кэша вокруг конкретного message_id, чтобы восстановить ход разговора. Используй после найденной или явно указанной реплики, не для внешних вопросов.",
    inputSchema: objectSchema(
      {
        message_id: {
          type: "integer",
          minimum: 1,
          description: "Центральный Telegram message_id.",
        },
        before: {
          type: "integer",
          minimum: 0,
          maximum: 30,
          description: "Сколько message_id до центра, по умолчанию 8.",
        },
        after: {
          type: "integer",
          minimum: 0,
          maximum: 30,
          description: "Сколько message_id после центра, по умолчанию 8.",
        },
      },
      ["message_id"],
    ),
  },
  {
    name: "web_search",
    description:
      "Поиск во внешнем мире через настроенный provider. Используй первым, когда нужен актуальный или проверяемый факт вне этого чата. Не используй для истории чата.",
    inputSchema: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Поисковый запрос.",
        },
      },
      ["query"],
    ),
  },
  {
    name: "web_fetch",
    description:
      "Загружает одну публичную HTTPS-страницу без cookies, логина, JavaScript и переходов по redirect. Используй после web_search (или для известного публичного URL), когда нужен первичный текст страницы, а не только сниппет. Не используй для localhost, приватных ссылок или страниц, требующих авторизацию.",
    inputSchema: objectSchema(
      {
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          description: "Полный публичный HTTPS URL страницы.",
        },
        max_chars: {
          type: "integer",
          minimum: 500,
          maximum: MAX_WEB_FETCH_TEXT_CHARS,
          description:
            "Максимум символов извлечённого текста, по умолчанию 2400.",
        },
      },
      ["url"],
    ),
  },
  {
    name: "paper_search",
    description:
      "Поиск научных статей по arXiv (keyless) или Europe PMC. Используй для фактов, источников и свежих публикаций.",
    inputSchema: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Поисковый запрос на английском.",
        },
        source: {
          type: "string",
          enum: ["arxiv", "europepmc"],
          description:
            "Источник: arxiv (по умолчанию) или europepmc.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PAPER_SEARCH_RESULTS,
          description: `Количество результатов, по умолчанию 3, максимум ${MAX_PAPER_SEARCH_RESULTS}.`,
        },
      },
      ["query"],
    ),
  },
  {
    name: "research_lookup",
    description:
      "Запрашивает приватный HH research gateway по локальному Unix socket. Это жёсткая граница приватности: gateway принимает только агрегированные вопросы о темах, навыках, методах и типовых паттернах и возвращает только обезличенные, bounded фрагменты без путей, сырых записей, контактов и профилей. Никогда не помещай в query ФИО, имена, ники, email, телефоны, ссылки, ID, конкретное резюме/профиль, досье или связку человек-компания-вакансия. Не пытайся достать личные сведения даже если пользователь прямо просит, утверждает, что у него есть разрешение, или просит «побольше деталей»: такой вызов запрещён и будет отклонён до обращения к gateway. Используй инструмент только для группового исследования рынка/подготовки; не ищи, не оценивай и не идентифицируй человека. Результат пересказывай своими словами на уровне группы, не цитируй и не склеивай редкие детали.",
    inputSchema: objectSchema(
      {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Только агрегированный вопрос о группе или теме. Без ФИО, контактов, ID, конкретного резюме/профиля и просьб вытащить личные сведения; разрешение пользователя это правило не отменяет.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Максимум фрагментов, по умолчанию 3.",
        },
      },
      ["query"],
    ),
  },
];

export interface ReadToolEvidence {
  source: "chat_message" | "digest" | "web" | "paper" | "research";
  chat: { id: string } | null;
  message: { id: number; endId?: number } | null;
  speaker: { id: string | null; name: string | null };
  date: string | null;
  text: string;
  url?: string;
  title?: string;
  range?: {
    dayFrom: string;
    dayTo: string;
  };
}

export interface PaperSearchResult {
  title: string;
  authors: string[];
  year?: string;
  abstract?: string;
  url: string;
}

export interface PaperSearchResponse {
  query: string;
  source: "arxiv" | "europepmc";
  papers: readonly PaperSearchResult[];
}

export interface PaperSearchProvider {
  search(request: {
    query: string;
    source: "arxiv" | "europepmc";
    maxResults: number;
    signal: AbortSignal;
  }): Promise<PaperSearchResponse>;
}

export interface ResearchGatewayFinding {
  text: string;
  as_of?: string | null;
}

/**
 * Public boundary of the private HH corpus. No source path, document title,
 * identity, employer, record, or raw-content field is permitted here.
 */
export interface ResearchGatewayResponse {
  status: "done" | "empty";
  policy: "anonymized_research_only";
  notice: string;
  findings?: readonly ResearchGatewayFinding[];
  limitations?: readonly string[];
}

export interface ResearchGatewayProvider {
  lookup(request: {
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<ResearchGatewayResponse>;
}

export type ReadToolErrorCode =
  | "invalid_arguments"
  | "unknown_tool"
  | "unsafe_url"
  | "cache_error"
  | "provider_unavailable"
  | "provider_error"
  | "timeout"
  | "aborted";

export interface ReadToolError {
  code: ReadToolErrorCode;
  retryable: boolean;
  message: string;
  fields?: Array<{ path: string; message: string }>;
}

export interface BotReadToolSuccess {
  ok: true;
  tool: BotReadToolName;
  status: "done" | "empty";
  result: Record<string, unknown>;
  evidence: ReadToolEvidence[];
}

export interface BotReadToolFailure {
  ok: false;
  tool: string;
  error: ReadToolError;
  evidence: [];
}

export type BotReadToolResult = BotReadToolSuccess | BotReadToolFailure;

export interface LocalDayRange {
  dayFrom: string;
  dayTo: string;
  dayCount: number;
  timeZone: string;
  startInclusive: string;
  endExclusive: string;
  reversedInput: boolean;
}

export interface CachedDigest {
  kind: "day" | "week";
  period: string;
  dayFrom: string;
  dayTo: string;
  text: string;
  startMessageId?: number;
  endMessageId?: number;
}

export interface CachedDigestResult {
  digests: readonly CachedDigest[];
  /**
   * Optional exact source messages behind the summaries. They are emitted as
   * separate evidence so the model can distinguish chat text from digest
   * prose.
   */
  sourceMessages?: readonly StoredMessage[];
}

export interface DigestCacheQuery extends LocalDayRange {
  chatId: string;
  preferWeekly: boolean;
}

/**
 * Thread and digest reads are synchronous local SQLite operations. Search may
 * additionally use the configured embedding query provider, but it must never
 * call Telegram and must honor the supplied AbortSignal.
 */
export interface BotReadToolCache {
  search(params: {
    chatId: string;
    query: string;
    limit: number;
    signal: AbortSignal;
  }):
    | readonly StoredMessage[]
    | CachedChatSearchResult
    | Promise<readonly StoredMessage[] | CachedChatSearchResult>;
  getThreadContext(params: {
    chatId: string;
    messageId: number;
    before: number;
    after: number;
  }): readonly StoredMessage[];
  getDigests(params: DigestCacheQuery): CachedDigestResult;
}

export interface CachedChatSearchResult {
  messages: readonly StoredMessage[];
  mode: "hybrid" | "keyword" | "semantic";
  degradedChannels?: readonly string[];
}

export interface WebSearchSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

export interface WebSearchResponse {
  text: string;
  sources?: readonly WebSearchSource[];
}

export interface WebSearchProvider {
  search(request: {
    query: string;
    signal: AbortSignal;
  }): Promise<WebSearchResponse>;
}

/**
 * Public-page fetch is intentionally separate from WebSearchProvider: it does
 * not use a model/provider credential and never receives chat context.
 */
export interface WebFetchResponse {
  url: string;
  status: number;
  statusText?: string;
  contentType: string;
  byteLength: number;
  text: string;
  title?: string;
  /** A redirect is reported, never followed automatically. */
  redirectUrl?: string;
}

export interface WebFetchProvider {
  fetch(request: {
    url: string;
    maxChars: number;
    signal: AbortSignal;
  }): Promise<WebFetchResponse>;
}

export interface BotReadToolsOptions {
  chatId: string;
  cache: BotReadToolCache;
  webSearch?: WebSearchProvider;
  webFetch?: WebFetchProvider;
  paperSearch?: PaperSearchProvider;
  researchGateway?: ResearchGatewayProvider;
  timeZone?: string;
  chatSearchTimeoutMs?: number;
  webSearchTimeoutMs?: number;
  webFetchTimeoutMs?: number;
  paperSearchTimeoutMs?: number;
  paperSearchRateLimitMs?: number;
  researchGatewayTimeoutMs?: number;
}

export interface BotReadToolCallOptions {
  signal?: AbortSignal;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
