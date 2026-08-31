/**
 * VK's `messages.send` has no rich-message rendering (see
 * `src/bot/prompt/formatting-section.ts`), so `VkBotTurnPublisher` must not
 * forward `TelegramPublication`'s markdown verbatim -- it would show up as
 * literal asterisks, hashes and pipes in the chat. The system prompt already
 * tells the model to avoid Markdown for VK chats, but `createTelegramPublication`
 * is transport-agnostic and its wide-table fallback (`renderWideTableRecords`
 * in `telegram-publication.ts`) unconditionally emits `**bold**` ordinals, so
 * this conversion is defense in depth, not just a model-compliance backstop.
 *
 * This is a bounded strip of the handful of constructs the Telegram Rich
 * Message contract actually teaches (see the sibling prompt file) -- not a
 * general CommonMark parser. Markdown that slips through unstripped degrades
 * to visible syntax, same as today, rather than a crash or dropped content.
 */
export function renderVkPlainText(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let fence: "`" | "~" | null = null;
  for (const line of lines) {
    if (fence !== null) {
      if (isFenceClose(line, fence)) {
        fence = null;
      } else {
        output.push(line);
      }
      continue;
    }
    const opened = FENCE_OPEN.exec(line);
    if (opened !== null) {
      // Drop the fence line itself (backticks/tildes plus any language hint).
      fence = opened[1].charAt(0) === "~" ? "~" : "`";
      continue;
    }
    if (HORIZONTAL_RULE.test(line)) {
      continue;
    }
    let text = line.replace(HEADING_PREFIX, "").replace(BLOCKQUOTE_PREFIX, "");
    text = renderVkInlineText(text);
    output.push(text);
  }
  return output.join("\n");
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/u;
const HORIZONTAL_RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/u;
const HEADING_PREFIX = /^ {0,3}#{1,6}\s+/u;
const BLOCKQUOTE_PREFIX = /^ {0,3}>\s?/u;
const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu;
const INLINE_CODE = /`([^`\n]+)`/gu;
const STRIKETHROUGH = /~~([^~\n]+)~~/gu;
const BOLD_STAR = /\*\*([^*\n]+)\*\*/gu;
const BOLD_UNDERSCORE = /__([^_\n]+)__/gu;
const ITALIC_STAR = /(?<!\*)\*([^*\n]+)\*(?!\*)/gu;
const ITALIC_UNDERSCORE = /(?<!_)_([^_\n]+)_(?!_)/gu;

function renderVkInlineText(text: string): string {
  return text
    .replaceAll("$$", "")
    .replace(LINK_PATTERN, "$1 ($2)")
    .replace(INLINE_CODE, "$1")
    .replace(STRIKETHROUGH, "$1")
    .replace(BOLD_STAR, "$1")
    .replace(BOLD_UNDERSCORE, "$1")
    .replace(ITALIC_STAR, "$1")
    .replace(ITALIC_UNDERSCORE, "$1");
}

function isFenceClose(line: string, char: "`" | "~"): boolean {
  return new RegExp(`^ {0,3}${char}{3,}\\s*$`, "u").test(line);
}
