import { InlineKeyboard } from "grammy";
import type { StoredHumanPersonaProposal } from "./store.js";

export interface ApprovalPosterStore {
  claimNextPendingHumanPersonaProposal(
    personaId: string,
    claimedBy: string,
    nowMs?: number,
  ): StoredHumanPersonaProposal | undefined;
  recordHumanPersonaApprovalPosted(
    id: string,
    approvalChatId: string,
    approvalMessageId: number,
    nowMs?: number,
  ): boolean;
}

export interface ApprovalPosterApiPort {
  sendMessage(
    chatId: string,
    text: string,
    replyMarkup: InlineKeyboard,
    signal?: AbortSignal,
  ): Promise<{ message_id: number }>;
}

export type ApprovalPosterTickStatus = "posted" | "empty" | "failed";

export interface ApprovalPosterTickReport {
  status: ApprovalPosterTickStatus;
  proposalId?: string;
  error?: { name: string; code: string };
}

export interface RunApprovalPosterTickOptions {
  store: ApprovalPosterStore;
  api: ApprovalPosterApiPort;
  personaId: string;
  approvalChatId: string;
  claimedBy: string;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * Claims one `approval`-autonomy pending proposal and posts it to the
 * approval chat with inline buttons (plan Фаза 4d/5 Шаг 5). Button presses
 * are handled entirely on the ingest side
 * (`src/bot/runtime/update-processor.ts`'s `hp:<action>:<id>` callback data
 * and its approval-chat reply capture) -- this module only ever posts.
 */
export async function runApprovalPosterTick(
  options: RunApprovalPosterTickOptions,
): Promise<ApprovalPosterTickReport> {
  const nowMs = (options.now ?? Date.now)();
  const proposal = options.store.claimNextPendingHumanPersonaProposal(
    options.personaId,
    options.claimedBy,
    nowMs,
  );
  if (!proposal) {
    return { status: "empty" };
  }
  try {
    const keyboard = new InlineKeyboard()
      .text("Подтвердить", `hp:approve:${proposal.id}`)
      .text("Отклонить", `hp:reject:${proposal.id}`)
      .row()
      .text("Перегенерировать", `hp:regenerate:${proposal.id}`)
      .text("Скорректировать", `hp:edit:${proposal.id}`);
    const posted = await options.api.sendMessage(
      options.approvalChatId,
      renderApprovalMessage(proposal),
      keyboard,
      options.signal,
    );
    options.store.recordHumanPersonaApprovalPosted(
      proposal.id,
      options.approvalChatId,
      posted.message_id,
      nowMs,
    );
    return { status: "posted", proposalId: proposal.id };
  } catch (error) {
    return {
      status: "failed",
      proposalId: proposal.id,
      error: safeErrorIdentity(error),
    };
  }
}

export interface ApprovalPosterLoopOptions extends Omit<
  RunApprovalPosterTickOptions,
  "signal"
> {
  /** Sleep between ticks when the queue is empty; a posted/failed tick retries immediately. */
  idleIntervalMs?: number;
  onTick?: (report: ApprovalPosterTickReport) => void;
}

const DEFAULT_IDLE_INTERVAL_MS = 15_000;

/**
 * Small standalone interval loop, run concurrently with the live bot's
 * long-poller (see `BotApiRuntime`) -- posting a proposal is driven by DB
 * state written by `bot-agi-sync`'s trigger-engine, not by a Telegram
 * update, so it cannot live inside `BotUpdateProcessor`.
 */
export class ApprovalPosterLoop {
  readonly #options: ApprovalPosterLoopOptions;
  readonly #idleIntervalMs: number;
  #running = false;

  constructor(options: ApprovalPosterLoopOptions) {
    this.#options = options;
    this.#idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
  }

  get running(): boolean {
    return this.#running;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) {
      throw new Error("ApprovalPosterLoop is already running.");
    }
    this.#running = true;
    try {
      while (!signal.aborted) {
        const report = await runApprovalPosterTick({
          ...this.#options,
          signal,
        });
        this.#options.onTick?.(report);
        if (report.status === "empty") {
          await abortableSleep(this.#idleIntervalMs, signal);
        }
      }
    } finally {
      this.#running = false;
    }
  }
}

function renderApprovalMessage(proposal: StoredHumanPersonaProposal): string {
  return [
    `Предложение персоны «${proposal.personaId}» для чата ${proposal.chatId}:`,
    "",
    proposal.proposedText,
    "",
    "Ответь на это сообщение, чтобы скорректировать текст.",
  ].join("\n");
}

function safeErrorIdentity(error: unknown): { name: string; code: string } {
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
          : "approval_poster_failed",
    };
  }
  return { name: "NonError", code: "approval_poster_failed" };
}

async function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
