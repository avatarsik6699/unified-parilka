import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { redactLogValue } from "./observability/redaction.js";

export class StderrGramJsLogger extends Logger {
  // GramJS's update loop bypasses Logger.log() and calls console.error(error)
  // whenever canSend(ERROR) is true. The service records normalized operation
  // failures itself, so NONE prevents duplicate unbounded raw stack traces.
  constructor(level: LogLevel = LogLevel.NONE) {
    super(level);
  }

  override log(level: LogLevel, message: string): void {
    console.error(`[gramjs:${level}] ${String(redactLogValue(message))}`);
  }
}
