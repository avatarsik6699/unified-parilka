export const CHAT_ID = -100_123_456_789;
export const BOT_ID = 7_700_011;
export const OPTIONS = {
  allowedChatIds: [String(CHAT_ID)],
  botId: String(BOT_ID),
  botUsername: "@ParilkaBot",
} as const;

export function botUpdate(overrides: Record<string, unknown> = {}): {
  update_id: number;
  message: Record<string, unknown>;
} {
  return {
    update_id: 91,
    message: baseMessage(overrides),
  };
}

export function baseMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message_id: 17,
    date: 1_700_000_000,
    chat: {
      id: CHAT_ID,
      type: "supergroup",
      title: "Парилка",
    },
    from: {
      id: 123_456,
      is_bot: false,
      username: "billy",
      first_name: "Billy",
    },
    text: "обычное сообщение",
    ...overrides,
  };
}
