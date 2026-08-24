import { chmodSync, existsSync } from "node:fs";
import { Api } from "grammy";
import { calendarDayInTimeZone } from "../digests.js";
import {
  AiSdkNewsBriefSummaryPort,
  NEWS_BRIEF_TIME_ZONE,
  NewsBriefSeenStore,
  grammyNewsBriefApi,
  runNewsBrief,
  type NewsBriefRunReport,
  type NewsBriefTelegramApi,
} from "../news-brief.js";
import type { JsonEventLogger } from "../observability/contracts.js";
import { FirecrawlClient } from "../bot/web-tools/firecrawl-client.js";
import { SearXNGClient } from "../bot/web-tools/searxng-client.js";
import { ModelRouter } from "../providers/model-router.js";
import { MessageStore } from "../store.js";
import { NewsBriefCliConfigError, parseOptions } from "./options.js";

const NEWS_BRIEF_THROTTLE = {
  maxAgeMs: 10 * 60_000,
  userCooldownMs: 0,
  maxPendingPerUserPerChat: 3,
  maxQueuePerChat: 3,
};

/** Optional DI for tests; production main wires createLogger({ service: "cli" }). */
export interface RunNewsBriefCliDeps {
  logger?: JsonEventLogger;
}

export async function runNewsBriefCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  output: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
  _deps: RunNewsBriefCliDeps = {},
): Promise<number> {
  process.umask(0o077);
  let store: MessageStore | undefined;
  try {
    const options = parseOptions(argv, env);

    // Both modes first prove that this is an already-migrated unified database.
    const preflight = new MessageStore(options.dbPath, { readOnly: true });
    preflight.close();

    if (options.apply) {
      makeDatabaseFilesPrivate(options.dbPath);
    }
    store = new MessageStore(options.dbPath, { readOnly: !options.apply });

    const searxng = new SearXNGClient({ origin: options.searxngEndpoint });
    const firecrawl = new FirecrawlClient({
      origin: options.firecrawlEndpoint,
    });
    const seenStore = NewsBriefSeenStore.load(options.seenStorePath);

    const summaryPort =
      options.apply && options.modelConfigPath
        ? new AiSdkNewsBriefSummaryPort(
            ModelRouter.fromFile(options.modelConfigPath),
            {
              ...(options.modelTotalTimeoutMs === undefined
                ? {}
                : { totalTimeoutMs: options.modelTotalTimeoutMs }),
              ...(options.modelCandidateTimeoutMs === undefined
                ? {}
                : { candidateTimeoutMs: options.modelCandidateTimeoutMs }),
            },
          )
        : undefined;

    const api: NewsBriefTelegramApi | undefined =
      options.apply && options.botToken
        ? grammyNewsBriefApi(new Api(options.botToken))
        : undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10 * 60_000);
    timer.unref?.();

    let report: NewsBriefRunReport;
    try {
      report = await runNewsBrief({
        store,
        chatId: options.chatId,
        apply: options.apply,
        searxng,
        firecrawl,
        seenStore,
        ...(summaryPort === undefined ? {} : { summaryPort }),
        ...(api === undefined ? {} : { api }),
        maxItems: options.maxItems,
        throttle: NEWS_BRIEF_THROTTLE,
        dayKey: calendarDayInTimeZone(new Date(), NEWS_BRIEF_TIME_ZONE),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    output.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    output.stderr.write(
      `${JSON.stringify({ ok: false, error: safeTopLevelError(error) })}\n`,
    );
    return 1;
  } finally {
    store?.close();
  }
}

export function runNewsBriefCliMain(): void {
  void runNewsBriefCli(process.argv.slice(2), process.env, process, {}).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
  );
}

function makeDatabaseFilesPrivate(dbPath: string): void {
  chmodSync(dbPath, 0o600);
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      chmodSync(sidecar, 0o600);
    }
  }
}

function safeTopLevelError(error: unknown): {
  name: string;
  code: string;
  message?: string;
} {
  if (error instanceof NewsBriefCliConfigError) {
    return { name: error.name, code: error.code, message: error.message };
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown; code?: unknown };
    return {
      name:
        typeof candidate.name === "string"
          ? candidate.name.slice(0, 80)
          : "Error",
      code:
        typeof candidate.code === "string" || typeof candidate.code === "number"
          ? String(candidate.code).slice(0, 80)
          : "news_brief_command_failed",
    };
  }
  return { name: "NonError", code: "news_brief_command_failed" };
}
