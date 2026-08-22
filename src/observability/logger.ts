import type { DestinationStream, Logger, LoggerOptions } from "pino";
import pino from "pino";
import { redactLogValue, safeError } from "./redaction.js";

export type ServiceName =
  | "bot"
  | "sync"
  | "maintenance"
  | "mcp"
  | "store"
  | "cli";

export type LoggerContext = {
  service: ServiceName;
  version?: string;
  commit?: string;
  environment?: string;
};

export function createLogger(
  context: LoggerContext,
  options: {
    level?: string;
    destination?: DestinationStream;
  } = {},
): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? process.env.BOT_LOG_LEVEL ?? "info",
    base: compact({
      service: context.service,
      version: context.version,
      commit: context.commit,
      environment: context.environment,
      pid: process.pid,
    }),
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      log(object) {
        return redactLogValue(object) as Record<string, unknown>;
      },
    },
    serializers: {
      err: serializeLogError,
      error: serializeLogError,
    },
  };

  // stderr is the only process-log sink. systemd/journald owns retention and
  // tailing, so the application cannot leave unbounded append-only files.
  return pino(loggerOptions, options.destination ?? pino.destination(2));
}

export function childLogger(
  logger: Logger,
  context: {
    runId?: string;
    turnId?: string;
    updateId?: number;
    chatId?: string;
    topicId?: number;
    provider?: string;
    model?: string;
  },
): Logger {
  return logger.child(compact(context));
}

function serializeLogError(value: unknown): ReturnType<typeof safeError> {
  if (
    value != null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).name === "string" &&
    typeof (value as Record<string, unknown>).message === "string"
  ) {
    const record = value as Record<string, unknown>;
    const projected = Object.assign(
      new Error(String(record.message)),
      {
        name: String(record.name),
        ...(typeof record.code === "string" ||
        typeof record.code === "number"
          ? { code: record.code }
          : {}),
        ...(typeof record.category === "string"
          ? { category: record.category }
          : {}),
        ...(typeof record.retryable === "boolean"
          ? { retryable: record.retryable }
          : {}),
      },
    );
    return safeError(projected);
  }
  return safeError(value);
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null)) as Partial<T>;
}
