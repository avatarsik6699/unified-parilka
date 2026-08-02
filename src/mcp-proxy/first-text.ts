export function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const item of content) {
    if (
      item != null &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "text" &&
      typeof (item as Record<string, unknown>).text === "string"
    ) {
      return (item as Record<string, string>).text;
    }
  }
  return undefined;
}
