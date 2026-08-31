import type { StoredMessage } from "../../store.js";
import type { VkMediaReference, VkMediaTarget } from "./vk-contracts.js";

const MAX_RAW_MESSAGE_CHARS = 2_000_000;
const MAX_URL_CHARS = 2_000;

type JsonObject = Record<string, unknown>;

/**
 * Extracts the VK photo reference from the raw JSON kept in the durable
 * store. `src/bot/vk-update.ts` writes this shape (`{ vkPhoto: {...} }`)
 * only when the incoming message actually carried a photo attachment; it
 * never collides with Telegram's `rawJson` shape (Bot API's `photo` field
 * sits at the top level, not nested under `vkPhoto`), so both parsers can
 * safely run over the same column.
 */
export function parseStoredVkPhoto(
  message: Pick<StoredMessage, "rawJson">,
): VkMediaReference | undefined {
  const raw = message.rawJson;
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_RAW_MESSAGE_CHARS
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const photo = asObject(asObject(parsed)?.vkPhoto);
  if (!photo) {
    return undefined;
  }
  const url = safeVkUrl(photo.url);
  if (!url) {
    return undefined;
  }
  const width = nonNegativeInteger(photo.width);
  const height = nonNegativeInteger(photo.height);
  return {
    kind: "vk_photo",
    url,
    mediaType: "image/jpeg",
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

/**
 * Convenience form mirroring `selectTelegramMediaTarget`: only the addressed
 * message and its direct reply target are eligible.
 */
export function selectVkPhotoTarget(
  trigger: StoredMessage,
  replyTarget?: StoredMessage,
): VkMediaTarget | undefined {
  const triggerPhoto = parseStoredVkPhoto(trigger);
  if (triggerPhoto) {
    return { ...triggerPhoto, source: "trigger", message: trigger };
  }
  if (replyTarget) {
    const replyPhoto = parseStoredVkPhoto(replyTarget);
    if (replyPhoto) {
      return { ...replyPhoto, source: "reply", message: replyTarget };
    }
  }
  return undefined;
}

/**
 * VK's CDN URL is server-chosen data embedded in a structured API payload,
 * not chat participant text, so it carries the same trust level as
 * Telegram's `file_id`. The host allowlist is defense in depth only, in case
 * a malformed or unexpected attachment payload ever reaches this parser.
 */
function safeVkUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_CHARS
  ) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === "vk.com" ||
    host === "vk.me" ||
    host.endsWith(".userapi.com") ||
    host.endsWith(".vk.com") ||
    host.endsWith(".vk-cdn.net");
  return allowed ? parsed.toString() : undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
