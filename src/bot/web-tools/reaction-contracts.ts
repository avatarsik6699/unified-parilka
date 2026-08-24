/**
 * Telegram's Bot API accepts only this fixed emoji set for
 * `setMessageReaction` (see core.telegram.org/bots/api#reactiontypeemoji) --
 * not arbitrary Unicode. Kept as the single source of truth for both the
 * tool's input schema and its runtime validation.
 */
export const TELEGRAM_REACTION_EMOJI = [
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
] as const;

export type TelegramReactionEmoji = (typeof TELEGRAM_REACTION_EMOJI)[number];

export interface BotReactionApiPort {
  setMessageReaction(
    chatId: string,
    messageId: number,
    emoji: TelegramReactionEmoji,
    signal: AbortSignal,
  ): Promise<{ ok: boolean }>;
}

/**
 * This turn's reaction capability: the live Bot API port plus the only two
 * message ids `react_to_message` may target -- the trigger message and its
 * direct reply, mirroring the addressed-media selection contract (never an
 * arbitrary message id from elsewhere in the chat).
 */
export interface ReactionCapability {
  api: BotReactionApiPort;
  chatId: string;
  triggerMessageId: number;
  replyMessageId?: number;
}
