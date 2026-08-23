import { chmodSync, existsSync } from "node:fs";
import {
  acquireStyleProfileProcessLock,
  runStyleProfileGeneration,
  AiSdkStyleProfilePort,
  type StyleProfileGenerationReport,
  type StyleProfileModelRouter,
  type StyleProfileProcessLock,
} from "../human-persona-style.js";
import { ModelRouter } from "../providers/model-router.js";
import { MessageStore } from "../store.js";
import { CliConfigError, parseOptions, type CliOptions } from "./options.js";

export async function runHumanPersonaStyleCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  output: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  process.umask(0o077);
  let lock: StyleProfileProcessLock | undefined;
  let store: MessageStore | undefined;
  try {
    const options: CliOptions = parseOptions(argv, env);

    // Both modes first prove that this is an already-migrated unified
    // database, mirroring the digest CLI's preflight (src/digest-cli/run.ts).
    const preflight = new MessageStore(options.dbPath, { readOnly: true });
    preflight.close();

    if (options.apply) {
      lock = acquireStyleProfileProcessLock(options.dbPath);
      makeDatabaseFilesPrivate(options.dbPath);
    }
    store = new MessageStore(options.dbPath, { readOnly: !options.apply });
    const router: StyleProfileModelRouter | undefined =
      options.apply && options.modelConfigPath
        ? ModelRouter.fromFile(options.modelConfigPath)
        : undefined;
    const port = router ? new AiSdkStyleProfilePort(router) : undefined;

    const report = await runStyleProfileGeneration({
      store,
      personaId: options.personaId,
      chatId: options.chatId,
      targetUserKey: options.targetUserKey,
      consentBasis: options.consentBasis,
      apply: options.apply,
      port,
    });

    output.stdout.write(
      `${JSON.stringify(
        { ...report, ...(lock ? { lock: { mechanism: lock.mechanism } } : {}) },
        null,
        2,
      )}\n`,
    );
    return report.status === "failed" ? 1 : 0;
  } catch (error) {
    output.stderr.write(
      `${JSON.stringify({ ok: false, error: safeTopLevelError(error) })}\n`,
    );
    return 1;
  } finally {
    store?.close();
    lock?.release();
  }
}

export function runHumanPersonaStyleCliMain(): void {
  void runHumanPersonaStyleCli().then((exitCode) => {
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
          : "human_persona_style_command_failed",
    };
  }
  return { name: "NonError", code: "human_persona_style_command_failed" };
}

export type { StyleProfileGenerationReport };
