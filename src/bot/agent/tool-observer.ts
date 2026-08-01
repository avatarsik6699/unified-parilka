import type { ToolProgressPort } from "../tool-progress.js";
import type { ReadToolEvidence } from "../read-tools/contracts.js";
import type { BotToolSetExecutionCompleted } from "./tool-set.js";
import { boundedSerialize, type CarriedToolResult } from "./evidence.js";

export interface BotToolCompletionObserverOptions {
  readonly traceContext: Readonly<Record<string, unknown>>;
  readonly candidate: string;
  readonly attempt: number;
  readonly approvalOrder: ReadonlyMap<string, number>;
  readonly allowedExecutions: () => number;
  readonly carriedTools: CarriedToolResult[];
  readonly toolEvidence: ReadToolEvidence[];
  readonly readToolFailures: Array<{ name: string; code: string }>;
  readonly toolProgressPort?: ToolProgressPort;
  readonly onCompleted: (execution: BotToolSetExecutionCompleted) => void;
  readonly log: (
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
}

/**
 * Keeps tool evidence and progress bookkeeping outside the turn-loop barrel.
 * The arrays intentionally belong to the whole turn so provider fallback and
 * research retries retain one bounded evidence set.
 */
export function createBotToolCompletionObserver(
  options: BotToolCompletionObserverOptions,
): (execution: BotToolSetExecutionCompleted) => void {
  return (execution): void => {
    options.onCompleted(execution);
    options.toolProgressPort?.onToolCompleted(
      { toolName: execution.name, callId: execution.callId },
      execution.output.ok,
    );
    const sequence =
      options.approvalOrder.get(execution.callId) ??
      options.allowedExecutions() + options.carriedTools.length + 1;
    if (execution.kind === "read" && execution.output.ok) {
      options.toolEvidence.push(...execution.output.evidence);
    }
    if (execution.kind === "read" && !execution.output.ok) {
      options.readToolFailures.push({
        name: execution.name,
        code: execution.output.error.code,
      });
    }
    options.carriedTools.push({
      sequence,
      name: execution.name,
      serialized: boundedSerialize(execution.output),
    });
    options.log("info", "bot.agent.tool", {
      ...options.traceContext,
      candidate: options.candidate,
      attempt: options.attempt,
      tool: execution.name,
      durationMs: Math.max(0, Date.now() - execution.startedAt),
      ok: execution.output.ok,
      status: execution.output.ok ? execution.output.status : undefined,
      errorCode: execution.output.ok
        ? undefined
        : execution.output.error.code,
    });
  };
}
