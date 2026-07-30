import { ToolError } from "../../errors.js";

export type MtcuteTransportErrorCode =
  | "invalid_config"
  | "not_configured"
  | "chat_not_allowed"
  | "client_owner_conflict"
  | "client_destroyed"
  | "connection_failed"
  | "invalid_request"
  | "pagination_stalled"
  | "reply_target_not_found"
  | "unsupported_message_shape";

export class MtcuteTransportError extends ToolError {
  readonly name = "MtcuteTransportError";

  constructor(
    readonly code: MtcuteTransportErrorCode,
    readonly category:
      | "auth"
      | "permission"
      | "peer"
      | "reply"
      | "validation"
      | "internal",
    readonly retryable: boolean,
    message: string,
    cause?: unknown,
  ) {
    super({ category, retryable, message });
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function invalidMtcuteConfig(message: string): MtcuteTransportError {
  return new MtcuteTransportError(
    "invalid_config",
    "validation",
    false,
    message,
  );
}

export function unsupportedMtcuteMessage(
  message: string,
): MtcuteTransportError {
  return new MtcuteTransportError(
    "unsupported_message_shape",
    "internal",
    false,
    message,
  );
}
