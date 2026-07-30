import type { MessageStore, StoredBotTurn } from "../../store.js";
import type { WorkerScheduler } from "./contracts.js";
import { WorkerAbortError } from "./helpers.js";

export interface TurnTimers {
  readonly leaseLost: boolean;
  readonly timedOut: boolean;
  readonly interruption: Promise<never>;
  stop(): void;
}

export interface StartTurnTimersOptions {
  store: MessageStore;
  turn: StoredBotTurn;
  workerId: string;
  leaseMs: number;
  heartbeatMs: number;
  turnTimeoutMs: number;
  scheduler: WorkerScheduler;
  now: () => number;
  controller: AbortController;
}

export function startTurnTimers(options: StartTurnTimersOptions): TurnTimers {
  const {
    store,
    turn,
    workerId,
    leaseMs,
    heartbeatMs,
    turnTimeoutMs,
    scheduler,
    now,
    controller,
  } = options;
    let stopped = false;
    const state = {
      leaseLost: false,
      timedOut: false,
    };
    let heartbeatHandle: unknown;
    let timeoutHandle: unknown;
    let interrupt!: (error: WorkerAbortError) => void;
    const interruption = new Promise<never>((_resolve, reject) => {
      interrupt = reject;
    });
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      scheduler.clearInterval(heartbeatHandle);
      scheduler.clearTimeout(timeoutHandle);
    };
    heartbeatHandle = scheduler.setInterval(() => {
      if (stopped) {
        return;
      }
      try {
        const renewed = store.renewBotTurnLease(
          turn.id,
          workerId,
          leaseMs,
          now(),
        );
        if (!renewed) {
          state.leaseLost = true;
          stop();
          const error = new WorkerAbortError("lease_lost");
          controller.abort(error);
          interrupt(error);
        }
      } catch {
        state.leaseLost = true;
        stop();
        const error = new WorkerAbortError("lease_lost");
        controller.abort(error);
        interrupt(error);
      }
    }, heartbeatMs);
    timeoutHandle = scheduler.setTimeout(() => {
      if (stopped) {
        return;
      }
      state.timedOut = true;
      stop();
      const error = new WorkerAbortError("turn_timeout");
      controller.abort(error);
      interrupt(error);
    }, turnTimeoutMs);
    return {
      get leaseLost() {
        return state.leaseLost;
      },
      get timedOut() {
        return state.timedOut;
      },
      interruption,
      stop,
    };
}

export const SYSTEM_SCHEDULER: WorkerScheduler = {
  setInterval(callback, delayMs) {
    return setInterval(callback, delayMs);
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
