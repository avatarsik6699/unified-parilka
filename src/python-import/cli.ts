import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CliOptions,
  ImportFailureReport,
  ImportPhase,
} from "./contracts.js";
import { inspectSource } from "./source.js";
import {
  assertDistinctFiles,
  assertHealthyLegacySource,
  assertSuitableTarget,
} from "./sqlite-guards.js";
import { applyImport } from "./target.js";
import { CanonicalMessageConflictError } from "./message-merge.js";

export function parseArgs(args: string[]): CliOptions {
  let sourcePath: string | undefined;
  let targetPath: string | undefined;
  let chatId: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (
      arg === "--source" ||
      arg === "--target" ||
      arg === "--chat-id"
    ) {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      if (arg === "--source") {
        sourcePath = resolve(value);
      } else if (arg === "--target") {
        targetPath = resolve(value);
      } else {
        chatId = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!sourcePath || !targetPath || !chatId) {
    throw new Error(
      "Usage: import-python-state --source BOT.sqlite --target messages.sqlite --chat-id -100… [--apply]",
    );
  }
  if (!/^-?\d+$/u.test(chatId)) {
    throw new Error("--chat-id must be a numeric Telegram chat ID.");
  }
  if (chatId.length > 256) {
    throw new Error("--chat-id must be at most 256 characters.");
  }
  return { sourcePath, targetPath, chatId, apply };
}

export async function runPythonImportCli(
  argv: readonly string[] = process.argv.slice(2),
  output: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  let phase: ImportPhase = "inspect";
  let targetMayBePartiallyModified = false;
  let source: DatabaseSync | undefined;
  try {
    const options = parseArgs([...argv]);
    assertDistinctFiles(options.sourcePath, options.targetPath);
    if (!existsSync(options.sourcePath)) {
      throw new Error(
        `Source database does not exist: ${options.sourcePath}`,
      );
    }

    source = new DatabaseSync(options.sourcePath, { readOnly: true });
    source.exec("PRAGMA query_only = ON");
    source.exec("PRAGMA busy_timeout = 5000");
    source.exec("BEGIN");
    assertHealthyLegacySource(source);
    const report = inspectSource(source, options);

    if (options.apply) {
      phase = "validate";
      assertSuitableTarget(options.targetPath);
      phase = "apply";
      // Message batches and digest rows commit idempotently but independently.
      // From this point an error can leave a valid, resumable partial import.
      targetMayBePartiallyModified = true;
      applyImport(source, options, report);
    }
    output.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const failure: ImportFailureReport = {
      event: "python_state_import_failed",
      phase,
      targetMayBePartiallyModified,
      ...(error instanceof CanonicalMessageConflictError
        ? { messageMerge: error.messageMerge }
        : {}),
      error: {
        code:
          error instanceof CanonicalMessageConflictError
            ? error.code
            : "migration_failed",
        message: safeImportErrorMessage(error),
      },
    };
    output.stderr.write(`${JSON.stringify(failure)}\n`);
    return 1;
  } finally {
    source?.close();
  }
}

export function runPythonImportCliMain(): void {
  void runPythonImportCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

function safeImportErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : "Unknown migration failure.";
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 500);
  if (
    /(?:bearer\s+|api[_-]?key|password|secret|token)/iu.test(
      normalized,
    )
  ) {
    return "Python state import failed; sensitive details were redacted.";
  }
  return normalized || "Unknown migration failure.";
}
