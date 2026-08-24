import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SEEN_RETENTION_MS } from "./types.js";

interface SeenEntry {
  urlHash: string;
  seenAtMs: number;
}

interface SeenFileShape {
  entries: SeenEntry[];
}

/**
 * Bounded local dedupe state so the same article isn't reposted the next
 * time it still ranks in a search. Deliberately a flat JSON file, not a new
 * SQLite table: this data never needs to be atomic with the bot/outbox/
 * embedding transaction kernel, so it stays out of it entirely.
 */
export class NewsBriefSeenStore {
  readonly #path: string;
  readonly #entries: Map<string, number>;

  private constructor(path: string, entries: Map<string, number>) {
    this.#path = path;
    this.#entries = entries;
  }

  static load(path: string): NewsBriefSeenStore {
    const entries = new Map<string, number>();
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<SeenFileShape>;
      if (Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          if (
            typeof entry?.urlHash === "string" &&
            typeof entry.seenAtMs === "number" &&
            Number.isSafeInteger(entry.seenAtMs)
          ) {
            entries.set(entry.urlHash, entry.seenAtMs);
          }
        }
      }
    } catch {
      // Missing or corrupt seen-store starts empty; it never blocks a run.
    }
    return new NewsBriefSeenStore(path, entries);
  }

  has(normalizedUrl: string, nowMs = Date.now()): boolean {
    const seenAtMs = this.#entries.get(hashUrl(normalizedUrl));
    return seenAtMs !== undefined && nowMs - seenAtMs < SEEN_RETENTION_MS;
  }

  markSeen(normalizedUrl: string, nowMs = Date.now()): void {
    this.#entries.set(hashUrl(normalizedUrl), nowMs);
  }

  save(nowMs = Date.now()): void {
    for (const [hash, seenAtMs] of this.#entries) {
      if (nowMs - seenAtMs >= SEEN_RETENTION_MS) {
        this.#entries.delete(hash);
      }
    }
    const entries: SeenEntry[] = Array.from(
      this.#entries,
      ([urlHash, seenAtMs]) => ({ urlHash, seenAtMs }),
    );
    const payload: SeenFileShape = { entries };
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(payload), { mode: 0o600 });
  }
}

function hashUrl(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl).digest("hex");
}
