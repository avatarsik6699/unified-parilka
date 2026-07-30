// Keep dotenv bootstrap first: real process env > local .env > shared .env.
import "./config/env-files.js";

export {
  BOOLEAN_ENV_RULES,
  NUMERIC_ENV_RULES,
} from "./config/env-rules.js";
export type {
  BooleanEnvRule,
  NumericEnvRule,
} from "./config/env-rules.js";
export {
  loadConfig,
  loadTelegramAuthConfig,
} from "./config/load.js";
export { expandPath } from "./config/paths.js";
export {
  redactedConfig,
  redactUrlCredentials,
} from "./config/redaction.js";
export { ToolSchemas } from "./config/types.js";
export type {
  AppConfig,
  MtcuteRuntimeConfig,
  TelegramAuthConfig,
  TelegramTransport,
} from "./config/types.js";
