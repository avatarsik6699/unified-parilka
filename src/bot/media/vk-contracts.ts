import type { StoredMessage } from "../../store.js";
import type { TelegramMediaSource } from "./contracts.js";

/**
 * VK photo attachments carry a plain HTTPS CDN URL directly in the message
 * payload rather than an opaque `file_id` resolved through a separate
 * authenticated call (Telegram's `getFile`). There is no VK analogue of
 * `TelegramMediaReference.fileId`, so this stays a small parallel shape
 * instead of forcing a shared union onto the Telegram type.
 */
export interface VkMediaReference {
  kind: "vk_photo";
  url: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  width?: number;
  height?: number;
}

export interface VkMediaTarget extends VkMediaReference {
  source: TelegramMediaSource;
  message: StoredMessage;
}
