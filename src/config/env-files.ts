import { parse as parseDotenv } from "dotenv";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { expandPath } from "./paths.js";

// Capture real process-level values before either managed dotenv layer is
// loaded. These keys always win over both shared and local files.
const INITIAL_ENV_KEYS = new Set(Object.keys(process.env));

loadEnvFile(
  configuredEnvPath(
    "TELEGRAM_SHARED_ENV_PATH",
    "~/.config/telegram-mcp/.env",
  ),
  false,
);
loadEnvFile(
  configuredEnvPath(
    "TELEGRAM_ENV_PATH",
    resolve(process.cwd(), ".env"),
  ),
  true,
);

function configuredEnvPath(
  name: string,
  fallback: string,
): string {
  const raw = process.env[name]?.trim();
  return expandPath(raw || fallback);
}

function loadEnvFile(
  path: string,
  preferOverLoadedFile: boolean,
): void {
  if (!existsSync(path)) {
    return;
  }
  const parsed = parseDotenv(readFileSync(path));
  for (const [key, value] of Object.entries(parsed)) {
    if (INITIAL_ENV_KEYS.has(key)) {
      continue;
    }
    if (
      process.env[key] == null ||
      preferOverLoadedFile
    ) {
      process.env[key] = value;
    }
  }
}
