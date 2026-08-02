import { ZodError } from "zod";

export type NormalizedError = {
  category: "rate_limit" | "permission" | "formatting" | "reply" | "peer" | "auth" | "validation" | "internal";
  telegramCode?: number;
  telegramType?: string;
  retryAfterSec?: number;
  retryable: boolean;
  message: string;
  fields?: Array<{ path: string; message: string }>;
};

/**
 * Error shape that may cross the MCP boundary.  Internal normalization keeps
 * transport detail for retries, persistence, and redacted logs; this shape
 * deliberately does not expose that detail to tool callers.
 */
export type PublicNormalizedError = Omit<
  NormalizedError,
  "telegramType"
>;

export const GENERIC_PUBLIC_ERROR_MESSAGE =
  "The tool could not complete.";

const MAX_PUBLIC_RETRY_AFTER_SEC = 24 * 60 * 60;
const UNKNOWN_CACHED_CHAT_ALIAS_PUBLIC_MESSAGE =
  "Unknown cached chat alias. Call resolve_chat or sync_history for this username once, then retry the cache-only tool.";

/** Only these exact, application-authored messages may cross the MCP boundary. */
const SAFE_APPLICATION_TOOL_MESSAGES = new Set([
  "Live send requires approval_id from preview_message.",
  "Live send approval was not found, expired, or already consumed.",
  "Live send approval expired. Preview the message again.",
  "Live send approval does not match chat, text, reply, parse mode, link preview, or silent flag.",
  "Previous send with this dedupe_key has an unknown Telegram delivery state; refusing automatic retry.",
  "Send with this dedupe_key is or was in-flight; Telegram delivery state is unknown, so automatic retry is refused.",
  "dedupe_key has already been used for a different send payload.",
  "Send with this dedupe_key is already queued or sending.",
  "Per-user cooldown is active.",
  "Per-user pending limit reached.",
  "Per-chat queue is full.",
  "Queued send expired before execution.",
  "Reserved send is no longer queued; refusing to dispatch it to Telegram.",
  "Embeddings are disabled. Set TELEGRAM_EMBEDDINGS_ENABLED=true.",
  "Embedding API key is missing. Set OPENAI_API_KEY or TELEGRAM_EMBEDDINGS_API_KEY.",
  UNKNOWN_CACHED_CHAT_ALIAS_PUBLIC_MESSAGE,
]);

export class ToolError extends Error {
  readonly normalized: NormalizedError;

  constructor(normalized: NormalizedError) {
    super(normalized.message);
    this.normalized = normalized;
  }
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof ToolError) {
    return error.normalized;
  }
  if (error instanceof ZodError) {
    return {
      category: "validation",
      retryable: false,
      message: "Invalid tool arguments.",
      fields: error.issues.flatMap((issue) => zodIssueFields(issue)),
    };
  }

  const anyError = error as {
    message?: string;
    errorMessage?: string;
    code?: number;
    seconds?: unknown;
    name?: string;
    constructor?: { name?: string };
  };
  const message = String(anyError?.errorMessage || anyError?.message || error || "Unknown error");
  const className = String(anyError?.constructor?.name ?? "");
  const errorName = String(anyError?.name ?? "");
  const telegramTypeSource = className || errorName || anyError?.errorMessage || "";
  const upper = message.toUpperCase();
  const typeUpper = [className, errorName, anyError?.errorMessage, message].filter(Boolean).join(" ").toUpperCase();
  const waitMatch = typeUpper.match(/(?:FLOOD(?:_PREMIUM)?_WAIT|SLOWMODE_WAIT)_?(\d+(?:\.\d+)?)/);
  const retryAfterSec = waitMatch ? Number(waitMatch[1]) : retryAfterSeconds(anyError?.seconds);

  if (waitMatch || isGramJsFloodWait(typeUpper, anyError?.code, retryAfterSec)) {
    return {
      category: "rate_limit",
      telegramCode: anyError?.code,
      telegramType: waitMatch?.[0] ?? telegramTypeSource,
      retryAfterSec,
      retryable: true,
      message,
    };
  }
  if (upper.includes("CHAT_WRITE_FORBIDDEN") || upper.includes("USER_BANNED") || upper.includes("FORBIDDEN")) {
    return {
      category: "permission",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }
  if (upper.includes("MESSAGE_TOO_LONG") || upper.includes("ENTITY_BOUNDS_INVALID")) {
    return {
      category: "formatting",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }
  if (upper.includes("REPLY_MESSAGE_ID_INVALID") || upper.includes("TOPIC_CLOSED")) {
    return {
      category: "reply",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }
  if (upper.includes("SESSION") || upper.includes("AUTH") || upper.includes("PHONE_CODE")) {
    return {
      category: "auth",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }
  if (
    upper.includes("ECONNRESET") ||
    upper.includes("ECONNREFUSED") ||
    upper.includes("ETIMEDOUT") ||
    upper.includes("EAI_AGAIN") ||
    upper.includes("TIMEOUT") ||
    upper.includes("NETWORK") ||
    upper.includes("CONNECTION") ||
    upper.includes("SOCKET")
  ) {
    return {
      category: "internal",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: true,
      message,
    };
  }
  if (upper.includes("USERNAME") || upper.includes("PEER") || upper.includes("CHANNEL_INVALID")) {
    return {
      category: "peer",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }

  return {
    category: "internal",
    telegramCode: anyError?.code,
    retryable: false,
    message,
  };
}

function zodIssueFields(issue: ZodError["issues"][number]): Array<{ path: string; message: string }> {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      path: [...issue.path.map(String), key].join("."),
      message: `Unrecognized key: ${key}`,
    }));
  }
  return [
    {
      path: issue.path.join("."),
      message: issue.message,
    },
  ];
}

function retryAfterSeconds(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function isGramJsFloodWait(typeUpper: string, code: number | undefined, retryAfterSec: number | undefined): boolean {
  if (retryAfterSec == null) {
    return false;
  }
  return (
    code === 420 ||
    typeUpper.includes("FLOODWAITERROR") ||
    typeUpper.includes("SLOWMODEWAITERROR") ||
    typeUpper.includes("FLOOD_WAIT") ||
    typeUpper.includes("SLOWMODE_WAIT") ||
    typeUpper.includes("FLOOD")
  );
}

export function ok<T extends Record<string, unknown>>(value: T): { ok: true } & T {
  return { ok: true, ...value };
}

/**
 * Projects an arbitrary failure for a public MCP response.
 *
 * Zod owns its field-level diagnostics, so those remain actionable.  Every
 * other unknown failure receives one stable message while retaining bounded
 * routing metadata that callers can act on.
 */
export function publicError(error: unknown): PublicNormalizedError {
  const normalized = normalizeError(error);
  if (error instanceof ZodError) {
    return {
      ...publicErrorMetadata(normalized),
      message: normalized.message,
      ...(normalized.fields == null
        ? {}
        : { fields: normalized.fields }),
    };
  }
  return {
    ...publicErrorMetadata(normalized),
    message:
      error instanceof ToolError
        ? publicToolErrorMessage(error)
        : GENERIC_PUBLIC_ERROR_MESSAGE,
  };
}

/**
 * Projects a persisted or nested normalized error.  Such values have lost the
 * provenance required to trust their message, so their text is never public.
 */
export function publicNormalizedError(
  error: NormalizedError,
): PublicNormalizedError {
  return {
    ...publicErrorMetadata(error),
    message: GENERIC_PUBLIC_ERROR_MESSAGE,
  };
}

export function publicFailure(
  error: unknown,
): { ok: false; error: PublicNormalizedError } {
  return { ok: false, error: publicError(error) };
}

/** Kept as the terse result helper used by existing MCP call sites. */
export function fail(
  error: unknown,
): { ok: false; error: PublicNormalizedError } {
  return publicFailure(error);
}

function publicErrorMetadata(
  error: NormalizedError,
): Omit<PublicNormalizedError, "message" | "fields"> {
  const telegramCode = publicTelegramCode(error.telegramCode);
  const retryAfterSec = publicRetryAfterSec(error.retryAfterSec);
  return {
    category: error.category,
    retryable: error.retryable === true,
    ...(telegramCode == null ? {} : { telegramCode }),
    ...(retryAfterSec == null ? {} : { retryAfterSec }),
  };
}

function publicTelegramCode(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function publicRetryAfterSec(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? Math.min(value, MAX_PUBLIC_RETRY_AFTER_SEC)
    : undefined;
}

function publicToolErrorMessage(error: ToolError): string {
  const message = error.normalized.message;
  if (SAFE_APPLICATION_TOOL_MESSAGES.has(message)) {
    return message;
  }
  if (
    /^Unknown cached chat alias .+\. Call resolve_chat or sync_history for this username once, then retry the cache-only tool\.$/u.test(
      message,
    )
  ) {
    return UNKNOWN_CACHED_CHAT_ALIAS_PUBLIC_MESSAGE;
  }
  return GENERIC_PUBLIC_ERROR_MESSAGE;
}
