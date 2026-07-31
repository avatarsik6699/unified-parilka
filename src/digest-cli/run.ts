import {
  chmodSync,
  existsSync,
} from "node:fs";
import {
  AiSdkSummaryPort,
  acquireDigestProcessLock,
  runDigestGeneration,
  type DigestGenerationReport,
  type DigestModelRouter,
  type DigestPhaseReport,
  type DigestProcessLock,
} from "../digests.js";
import { ModelRouter } from "../providers/model-router.js";
import { MessageStore } from "../store.js";
import {
  runDreamPass,
  type DreamPassResult,
} from "./dream-pass.js";
import {
  integerFromEnvironment,
  parseOptions,
  type CliOptions,
  CliConfigError,
} from "./options.js";

export async function runDigestCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  output: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  process.umask(0o077);
  let lock: DigestProcessLock | undefined;
  let store: MessageStore | undefined;
  try {
    const options: CliOptions = parseOptions(argv, env);

    // Both modes first prove that this is an already-migrated unified database.
    // Dry-runs and mistimed scheduled runs never migrate production state.
    const preflight = new MessageStore(options.dbPath, {
      readOnly: true,
    });
    preflight.close();

    if (options.apply) {
      lock = acquireDigestProcessLock(options.dbPath);
      makeDatabaseFilesPrivate(options.dbPath);
    }
    store = new MessageStore(options.dbPath, {
      readOnly: !options.apply,
    });
    const router: DigestModelRouter | undefined =
      options.apply && options.modelConfigPath
        ? ModelRouter.fromFile(options.modelConfigPath)
        : undefined;
    const summaryPort = router
      ? new AiSdkSummaryPort(router, {
          maxOutputTokens: integerFromEnvironment(
            env.PARILKA_DIGEST_MAX_OUTPUT_TOKENS,
            "PARILKA_DIGEST_MAX_OUTPUT_TOKENS",
            64,
            32_768,
            2_048,
          ),
          totalTimeoutMs: options.modelTotalTimeoutMs,
          candidateTimeoutMs: options.modelCandidateTimeoutMs,
        })
      : undefined;
    const report = await runDigestGeneration({
      store,
      chatId: options.chatId,
      apply: options.apply,
      all: options.all,
      summaryPort,
      maxInputChars: options.maxInputChars,
      maxOutputChars: options.maxOutputChars,
      itemTimeoutMs: options.itemTimeoutMs,
      maxDayGenerationsPerRun:
        options.maxDayGenerationsPerRun,
      maxWeekGenerationsPerRun:
        options.maxWeekGenerationsPerRun,
    });
    const dream = await runDreamPass(
      store,
      {
        chatId: options.chatId,
        apply: options.apply,
        dreamEveryNMessages: options.dreamEveryNMessages,
        dreamMaxMessages: options.dreamMaxMessages,
        memoryMaxChars: options.memoryMaxChars,
        modelConfigPath: options.modelConfigPath,
        modelTotalTimeoutMs: options.modelTotalTimeoutMs,
        modelCandidateTimeoutMs: options.modelCandidateTimeoutMs,
      },
      router,
    );
    const reportOutput = options.summaryOnly
      ? compactDigestReport(report)
      : report;
    output.stdout.write(
      `${JSON.stringify(
        {
          ...reportOutput,
          dream,
          ...(lock
            ? {
                lock: {
                  mechanism: lock.mechanism,
                },
              }
            : {}),
        },
        null,
        options.summaryOnly ? undefined : 2,
      )}\n`,
    );
    return report.days.failed > 0 || report.weeks.failed > 0 || dream.status === "failed"
      ? 1
      : 0;
  } catch (error) {
    output.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: safeTopLevelError(error),
      })}\n`,
    );
    return 1;
  } finally {
    store?.close();
    lock?.release();
  }
}

export function compactDigestReport(
  report: DigestGenerationReport,
): Omit<DigestGenerationReport, "days" | "weeks"> & {
  days: CompactDigestPhaseReport;
  weeks: CompactDigestPhaseReport;
} {
  return {
    ...report,
    days: compactDigestPhase(report.days),
    weeks: compactDigestPhase(report.weeks),
  };
}

type CompactDigestFailure = {
  period: string;
  reason: string;
  error?: {
    name: string;
    code: string;
  };
};

type CompactDigestPhaseReport = Omit<DigestPhaseReport, "items"> & {
  generatedPeriods: string[];
  failures: CompactDigestFailure[];
  failuresOmitted: number;
};

function compactDigestPhase(
  phase: DigestPhaseReport,
): CompactDigestPhaseReport {
  const allFailures = phase.items.filter(
    ({ status }) => status === "failed",
  );
  const failures = allFailures.slice(0, 20).map(
    ({ period, reason, error }) => ({
      period,
      reason,
      ...(error === undefined ? {} : { error }),
    }),
  );
  return {
    scanned: phase.scanned,
    candidates: phase.candidates,
    planned: phase.planned,
    providerCalls: phase.providerCalls,
    generated: phase.generated,
    unchanged: phase.unchanged,
    invalidated: phase.invalidated,
    deferred: phase.deferred,
    skipped: phase.skipped,
    failed: phase.failed,
    generatedPeriods: phase.items
      .filter(({ status }) => status === "generated")
      .map(({ period }) => period),
    failures,
    failuresOmitted: allFailures.length - failures.length,
  };
}

export function runDigestCliMain(): void {
  void runDigestCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
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
  if (error instanceof CliConfigError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
    };
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      name?: unknown;
      code?: unknown;
    };
    return {
      name:
        typeof candidate.name === "string"
          ? candidate.name.slice(0, 80)
          : "Error",
      code:
        typeof candidate.code === "string" ||
        typeof candidate.code === "number"
          ? String(candidate.code).slice(0, 80)
          : "digest_command_failed",
    };
  }
  return { name: "NonError", code: "digest_command_failed" };
}
