const SENSITIVE_KEY =
  /(?:^|[_-]|(?<=[a-z]))(api[_-]?(?:key|hash)|auth(?:orization)?|bearer|cookie|credential|password|private[_-]?key|secret|session|string[_-]?session|token)(?:$|[_-])/i;
const SENSITIVE_QUERY_KEY =
  /^(?:access[_-]?token|api[_-]?(?:key|hash)|auth(?:orization)?|bearer|code|credential|key|password|secret|session|sig(?:nature)?|token)$/i;

const REDACTED = "[REDACTED]";
const MAX_LOG_STRING = 2_000;
const MAX_DEPTH = 8;
const EMBEDDED_HTTP_URL = /https?:\/\/[^\s<>"']+/giu;
const EMBEDDED_SECRET_PATTERNS: readonly (readonly [
  RegExp,
  string,
])[] = [
  [
    /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}={0,2}\b/giu,
    `$1${REDACTED}`,
  ],
  [/\bsk[-_][A-Za-z0-9._-]{12,}\b/giu, REDACTED],
  [/\bya29\.[A-Za-z0-9._-]{16,}\b/giu, REDACTED],
  [/\b\d{6,16}:[A-Za-z0-9_-]{20,}\b/gu, REDACTED],
  [
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
    REDACTED,
  ],
  [/\b[a-f0-9]{32}\b/gu, REDACTED],
];

export function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return truncate(value);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return truncate(value);
  }

  if (url.username) {
    url.username = REDACTED;
  }
  if (url.password) {
    url.password = REDACTED;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      url.searchParams.set(key, REDACTED);
    }
  }
  url.hash = "";
  return truncate(url.toString());
}

export function providerIdentityUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return value.trim().replace(/\/+$/, "");
  }

  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function redactLogValue(value: unknown): unknown {
  return redactInner(value, 0, new WeakSet<object>());
}

export type SafeError = {
  name: string;
  message: string;
  code?: string | number;
  category?: string;
  retryable?: boolean;
  stack?: string;
};

export function safeError(error: unknown): SafeError {
  if (!(error instanceof Error)) {
    return {
      name: "NonError",
      message: sanitizeString(String(redactLogValue(error))),
    };
  }
  const source = error as Error & {
    code?: unknown;
    category?: unknown;
    retryable?: unknown;
  };
  return {
    name: (error.name || "Error").slice(0, 100),
    message: sanitizeString(error.message),
    ...(typeof source.code === "string"
      ? { code: source.code.slice(0, 100) }
      : typeof source.code === "number"
        ? { code: source.code }
        : {}),
    ...(typeof source.category === "string" ? { category: source.category } : {}),
    ...(typeof source.retryable === "boolean" ? { retryable: source.retryable } : {}),
    ...(source.category === undefined && error.stack !== undefined
      ? { stack: sanitizeString(error.stack.split("\n").slice(0, 15).join("\n")) }
      : {}),
  };
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (depth >= MAX_DEPTH) {
    return "[MAX_DEPTH]";
  }
  if (value instanceof Error) {
    return safeError(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactInner(entry, depth + 1, seen));
  }
  if (typeof value !== "object") {
    return truncate(String(value));
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactInner(entry, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function sanitizeString(value: string): string {
  let sanitized = value.replace(EMBEDDED_HTTP_URL, (match) => {
    const trailing = match.match(/[),.;:!?]+$/u)?.[0] ?? "";
    const candidate =
      trailing.length === 0
        ? match
        : match.slice(0, -trailing.length);
    return `${redactUrl(candidate)}${trailing}`;
  });
  for (const [pattern, replacement] of EMBEDDED_SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return truncate(sanitized);
}

function truncate(value: string): string {
  if (value.length <= MAX_LOG_STRING) {
    return value;
  }
  return `${value.slice(0, MAX_LOG_STRING)}…[TRUNCATED:${value.length - MAX_LOG_STRING}]`;
}
