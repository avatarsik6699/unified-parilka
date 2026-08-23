import type { StoredHumanPersonaProposal } from "./store.js";

export interface HumanPersonaSendStore {
  claimNextPendingAutoHumanPersonaProposal(
    personaId: string,
    claimedBy: string,
    nowMs?: number,
  ): StoredHumanPersonaProposal | undefined;
  getNextDecidedHumanPersonaProposal(
    personaId: string,
  ): StoredHumanPersonaProposal | undefined;
  recordHumanPersonaProposalDecision(
    id: string,
    status: "approved",
    finalText: string | undefined,
    nowMs?: number,
  ): boolean;
  markHumanPersonaProposalSent(id: string, nowMs?: number): boolean;
  markHumanPersonaProposalExpired(id: string, nowMs?: number): boolean;
}

export interface HumanPersonaSendTelegramPort {
  sendMessage(params: { chat: string; text: string }): Promise<{ id?: number }>;
}

export interface HumanPersonaSendRegeneratePort {
  regenerate(
    proposal: StoredHumanPersonaProposal,
  ): Promise<{ status: string; proposalId?: string }>;
}

export type HumanPersonaSendTickStatus =
  | "sent_auto"
  | "sent_approved"
  | "regenerated"
  | "regenerate_failed"
  | "send_failed"
  | "idle";

export interface HumanPersonaSendTickReport {
  status: HumanPersonaSendTickStatus;
  proposalId?: string;
  error?: { name: string; code: string };
}

export interface RunHumanPersonaSendTickOptions {
  store: HumanPersonaSendStore;
  telegram: HumanPersonaSendTelegramPort;
  regenerate: HumanPersonaSendRegeneratePort;
  personaId: string;
  claimedBy: string;
  now?: () => number;
}

/**
 * One send-tick (plan Фаза 4c/4d/5 Шаг 6): auto-mode proposals send
 * directly (self-approved through the same state machine approval-mode
 * uses, not a separate one); approval-mode proposals send only once a
 * human decided approved/edited; `regenerate_requested` hands back to the
 * trigger-engine for a fresh attempt instead of sending. `rejected` needs
 * no action here -- it is already terminal.
 *
 * At most one proposal is handled per call so a slow/failed send never
 * blocks the caller's other per-tick work (mirrors the trigger-engine's
 * one-decision-per-tick shape in `human-persona-trigger/tick.ts`).
 */
export async function runHumanPersonaSendTick(
  options: RunHumanPersonaSendTickOptions,
): Promise<HumanPersonaSendTickReport> {
  const nowMs = (options.now ?? Date.now)();

  const autoProposal = options.store.claimNextPendingAutoHumanPersonaProposal(
    options.personaId,
    options.claimedBy,
    nowMs,
  );
  if (autoProposal) {
    options.store.recordHumanPersonaProposalDecision(
      autoProposal.id,
      "approved",
      undefined,
      nowMs,
    );
    return sendAndMark(
      options.store,
      options.telegram,
      autoProposal,
      "sent_auto",
      nowMs,
    );
  }

  const decided = options.store.getNextDecidedHumanPersonaProposal(
    options.personaId,
  );
  if (!decided) {
    return { status: "idle" };
  }

  if (decided.status === "regenerate_requested") {
    try {
      const result = await options.regenerate.regenerate(decided);
      options.store.markHumanPersonaProposalExpired(decided.id, nowMs);
      return { status: "regenerated", proposalId: result.proposalId };
    } catch (error) {
      return {
        status: "regenerate_failed",
        proposalId: decided.id,
        error: safeErrorIdentity(error),
      };
    }
  }

  return sendAndMark(
    options.store,
    options.telegram,
    decided,
    "sent_approved",
    nowMs,
  );
}

async function sendAndMark(
  store: HumanPersonaSendStore,
  telegram: HumanPersonaSendTelegramPort,
  proposal: StoredHumanPersonaProposal,
  statusOnSuccess: "sent_auto" | "sent_approved",
  nowMs: number,
): Promise<HumanPersonaSendTickReport> {
  try {
    await telegram.sendMessage({
      chat: proposal.chatId,
      text: proposal.finalText ?? proposal.proposedText,
    });
    store.markHumanPersonaProposalSent(proposal.id, nowMs);
    return { status: statusOnSuccess, proposalId: proposal.id };
  } catch (error) {
    return {
      status: "send_failed",
      proposalId: proposal.id,
      error: safeErrorIdentity(error),
    };
  }
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
          : "human_persona_send_failed",
    };
  }
  return { name: "NonError", code: "human_persona_send_failed" };
}
