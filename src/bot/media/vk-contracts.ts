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

/**
 * VK voice messages (`audio_message` attachment) carry `link_ogg`/`link_mp3`
 * -- same directly-downloadable CDN shape as a photo, just a different
 * attachment type.
 */
export interface VkAudioReference {
  kind: "vk_voice";
  url: string;
  mediaType: "audio/ogg" | "audio/mpeg";
  durationSeconds?: number;
}

export interface VkAudioTarget extends VkAudioReference {
  source: TelegramMediaSource;
  message: StoredMessage;
}
