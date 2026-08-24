const MAX_TRACKED_TURNS = 1_000;

export type ImageGenerationBudgetDenialCode = "turn_limit" | "day_limit";

export interface ImageGenerationBudgetReservation {
  ok: boolean;
  code?: ImageGenerationBudgetDenialCode;
}

/**
 * Per-agent-instance cost guard for `generate_image`, since Runware calls
 * are paid per image and there is no generic spend-guard elsewhere in the
 * codebase to reuse (see src/bot/agent/web-images.ts for the closest
 * precedent, which bounds *downloaded* image bytes, not generation calls).
 *
 * Two independent caps: a per-turn cap (keyed by turn id, since a single
 * logical turn may re-run the tool-call loop across several model-step
 * attempts sharing the same turn id) and a per-day cap that persists across
 * turns for the lifetime of this process. Both reset only on process
 * restart -- acceptable at this bot's volume (one chat, a handful of images
 * a day).
 */
export class ImageGenerationBudget {
  readonly #maxPerTurn: number;
  readonly #maxPerDay: number;
  readonly #now: () => Date;
  #dayKey: string;
  #dayCount = 0;
  #turnCounts = new Map<string, number>();

  constructor(
    maxImagesPerTurn: number,
    maxImagesPerChatPerDay: number,
    now: () => Date = () => new Date(),
  ) {
    this.#maxPerTurn = maxImagesPerTurn;
    this.#maxPerDay = maxImagesPerChatPerDay;
    this.#now = now;
    this.#dayKey = utcDayKey(now());
  }

  /**
   * Optimistically reserves one image slot for `turnId`. Call `commit` on a
   * successful generation, or `release` if the generation call itself
   * failed -- a failed API call must not consume the budget.
   */
  reserve(turnId: string): ImageGenerationBudgetReservation {
    this.#rolloverIfNeeded();
    const turnCount = this.#turnCounts.get(turnId) ?? 0;
    if (turnCount >= this.#maxPerTurn) {
      return { ok: false, code: "turn_limit" };
    }
    if (this.#dayCount >= this.#maxPerDay) {
      return { ok: false, code: "day_limit" };
    }
    this.#setTurnCount(turnId, turnCount + 1);
    this.#dayCount += 1;
    return { ok: true };
  }

  /** No-op placeholder for symmetry with `release`; a reservation that led
   * to a successful generation stays counted. */
  commit(_turnId: string): void {
    // Intentionally empty: reserve() already counted the slot.
  }

  /** Frees a reservation that did not result in a generated image. */
  release(turnId: string): void {
    const turnCount = this.#turnCounts.get(turnId) ?? 0;
    if (turnCount > 0) {
      this.#setTurnCount(turnId, turnCount - 1);
    }
    this.#dayCount = Math.max(0, this.#dayCount - 1);
  }

  #setTurnCount(turnId: string, count: number): void {
    if (count <= 0) {
      this.#turnCounts.delete(turnId);
      return;
    }
    if (
      this.#turnCounts.size >= MAX_TRACKED_TURNS &&
      !this.#turnCounts.has(turnId)
    ) {
      this.#turnCounts.clear();
    }
    this.#turnCounts.set(turnId, count);
  }

  #rolloverIfNeeded(): void {
    const key = utcDayKey(this.#now());
    if (key !== this.#dayKey) {
      this.#dayKey = key;
      this.#dayCount = 0;
      this.#turnCounts.clear();
    }
  }
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
