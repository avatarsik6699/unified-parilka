import { publicFailure } from "../errors.js";
import { stringify } from "../json.js";
import type { ToolContent } from "./contracts.js";

export function jsonTool(payload: unknown): ToolContent {
  return {
    content: [{ type: "text", text: stringify(payload) }],
    ...(isFailedToolPayload(payload) ? { isError: true } : {}),
  };
}

export function toolFailure(error: unknown): ToolContent {
  return jsonTool(publicFailure(error));
}

export function throwIfToolAborted(
  signal: AbortSignal | undefined,
): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException(
        "MCP tool request was cancelled.",
        "AbortError",
      );
}

function isFailedToolPayload(
  payload: unknown,
): payload is { ok: false } {
  return (
    payload != null &&
    typeof payload === "object" &&
    "ok" in payload &&
    payload.ok === false
  );
}
