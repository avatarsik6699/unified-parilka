#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseLoopbackMcpEndpoint } from "./mcp-loopback.js";
import { runDirect } from "./mcp-proxy/direct.js";
import { runProxy } from "./mcp-proxy/proxy.js";
import { createLogger } from "./observability/logger.js";
import { safeError } from "./observability/redaction.js";
import { stringify } from "./json.js";

const logger = createLogger({ service: "mcp" });

export async function main(): Promise<void> {
  const endpoint = parseLoopbackMcpEndpoint();
  if (process.argv.includes("--validate-config")) {
    const { loadConfig, redactedConfig } = await import("./config.js");
    const config = loadConfig();
    process.stdout.write(
      `${stringify({
        ok: true,
        config: redactedConfig(config),
        mcp: { mode: "proxy", url: endpoint.url.href },
      })}
`,
    );
    return;
  }
  if (process.argv.includes("--print-config")) {
    const { loadConfig, redactedConfig } = await import("./config.js");
    const config = loadConfig();
    process.stdout.write(
      `${stringify({
        ...redactedConfig(config),
        mcp: { mode: "proxy", url: endpoint.url.href },
      })}
`,
    );
    return;
  }

  if (process.argv.includes("--direct")) {
    await runDirect(logger);
    return;
  }
  await runProxy(endpoint, logger);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error) => {
    logger.error({
      event: "mcp.fatal",
      error: safeError(error),
    });
    process.exitCode = 1;
  });
}
