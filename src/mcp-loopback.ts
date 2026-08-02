import type { Server as NodeHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { createParilkaMcpServer,
  type ParilkaToolRegistry,
} from "./mcp-protocol.js";
import { redactLogValue } from "./observability/redaction.js";

const DEFAULT_MCP_HTTP_URL = "http://127.0.0.1:8766/mcp";
const LOOPBACK_HOST = "127.0.0.1";
const MIN_PORT = 1_024;
const MAX_PORT = 65_535;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const MIN_SESSION_IDLE_TIMEOUT_MS = 10;

export interface LoopbackMcpEndpoint {
  url: URL;
  host: typeof LOOPBACK_HOST;
  port: number;
}

export function parseLoopbackMcpEndpoint(
  raw =
    process.env.PARILKA_MCP_HTTP_URL?.trim() ||
    DEFAULT_MCP_HTTP_URL,
): LoopbackMcpEndpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PARILKA_MCP_HTTP_URL must be a valid URL.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK_HOST ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PARILKA_MCP_HTTP_URL must be an uncredentialed " +
        "http://127.0.0.1:<port>/mcp URL without query or fragment.",
    );
  }
  const port = Number(url.port);
  if (
    !Number.isSafeInteger(port) ||
    port < MIN_PORT ||
    port > MAX_PORT
  ) {
    throw new Error(
      `PARILKA_MCP_HTTP_URL port must be between ${MIN_PORT} and ${MAX_PORT}.`,
    );
  }
  return { url, host: LOOPBACK_HOST, port };
}

export interface LoopbackMcpServerOptions {
  registry: ParilkaToolRegistry;
  endpoint?: LoopbackMcpEndpoint;
  /**
   * Tests may ask the kernel for an ephemeral port. Runtime configuration is
   * still required to use a fixed, bounded port through
   * parseLoopbackMcpEndpoint().
   */
  testPort?: 0;
  onError?: (error: unknown) => void;
  /**
   * Loopback sessions are intentionally bounded even though only local
   * clients can connect. Overrides exist for deterministic lifecycle tests.
   */
  maxSessions?: number;
  sessionIdleTimeoutMs?: number;
}

type LoopbackMcpSession = {
  protocol: ReturnType<typeof createParilkaMcpServer>;
  transport: StreamableHTTPServerTransport;
  sessionId?: string;
  activeRequests: number;
  lastActivityAtMs: number;
  closing?: Promise<void>;
};

export class LoopbackMcpServer {
  readonly #registry: ParilkaToolRegistry;
  readonly #endpoint: LoopbackMcpEndpoint;
  readonly #testPort: 0 | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #maxSessions: number;
  readonly #sessionIdleTimeoutMs: number;
  readonly #sessions = new Map<string, LoopbackMcpSession>();
  readonly #allSessions = new Set<LoopbackMcpSession>();
  #httpServer: NodeHttpServer | undefined;
  #sessionSweepTimer: NodeJS.Timeout | undefined;
  #url: URL | undefined;

  constructor(options: LoopbackMcpServerOptions) {
    this.#registry = options.registry;
    this.#endpoint =
      options.endpoint ?? parseLoopbackMcpEndpoint();
    this.#testPort = options.testPort;
    this.#maxSessions = boundedInteger(
      options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      1,
      1_024,
      "maxSessions",
    );
    this.#sessionIdleTimeoutMs = boundedInteger(
      options.sessionIdleTimeoutMs ??
        DEFAULT_SESSION_IDLE_TIMEOUT_MS,
      MIN_SESSION_IDLE_TIMEOUT_MS,
      24 * 60 * 60_000,
      "sessionIdleTimeoutMs",
    );
    this.#onError =
      options.onError ??
      ((error) => {
        const message =
          error instanceof Error
            ? String(redactLogValue(error.message))
            : "unknown MCP error";
        process.stderr.write(
          `${JSON.stringify({
            event: "mcp.loopback.error",
            error: { code: "loopback_mcp_error", message },
          })}\n`,
        );
      });
  }

  get running(): boolean {
    return this.#httpServer !== undefined;
  }

  get url(): URL | undefined {
    return this.#url == null ? undefined : new URL(this.#url);
  }

  get activeSessionCount(): number {
    return this.#allSessions.size;
  }

  async start(): Promise<URL> {
    if (this.#httpServer) {
      throw new Error("Loopback MCP server is already running.");
    }
    const configuredPort = this.#testPort ?? this.#endpoint.port;
    const app = createMcpExpressApp({
      host: this.#endpoint.host,
      allowedHosts: [LOOPBACK_HOST, "localhost"],
    });

    app.post("/mcp", async (request: Request, response: Response) => {
      if (!requestOriginAllowed(request, this.#url, configuredPort)) {
        response.status(403).json(forbiddenOrigin());
        return;
      }
      const sessionId = requestSessionId(request);
      let session =
        sessionId == null
          ? undefined
          : this.#sessions.get(sessionId);
      let created = false;
      let requestCounted = false;
      try {
        if (!session) {
          if (sessionId != null) {
            response.status(404).json(invalidSession());
            return;
          }
          if (!isInitializeRequest(request.body)) {
            response.status(400).json(missingSession());
            return;
          }
          this.#sweepIdleSessions();
          if (this.#allSessions.size >= this.#maxSessions) {
            response.status(503).json(sessionCapacityReached());
            return;
          }
          session = this.#createSession(configuredPort);
          created = true;
        }
        session.activeRequests += 1;
        session.lastActivityAtMs = Date.now();
        requestCounted = true;
        if (created) {
          await session.protocol.connect(session.transport);
        }
        await session.transport.handleRequest(
          request,
          response,
          request.body,
        );
        if (created && session.transport.sessionId == null) {
          await this.#disposeSession(session);
        }
      } catch (error) {
        if (created && session) {
          await this.#disposeSession(session).catch(this.#onError);
        }
        this.#onError(error);
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      } finally {
        if (requestCounted && session) {
          session.activeRequests = Math.max(
            0,
            session.activeRequests - 1,
          );
          session.lastActivityAtMs = Date.now();
        }
      }
    });
    app.get("/mcp", (_request: Request, response: Response) => {
      response.status(405).json(methodNotAllowed());
    });
    app.delete("/mcp", async (request: Request, response: Response) => {
      if (!requestOriginAllowed(request, this.#url, configuredPort)) {
        response.status(403).json(forbiddenOrigin());
        return;
      }
      const sessionId = requestSessionId(request);
      const session =
        sessionId == null
          ? undefined
          : this.#sessions.get(sessionId);
      if (!session) {
        response
          .status(sessionId == null ? 400 : 404)
          .json(
            sessionId == null
              ? missingSession()
              : invalidSession(),
          );
        return;
      }
      try {
        await session.transport.handleRequest(
          request,
          response,
          request.body,
        );
      } catch (error) {
        this.#onError(error);
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      } finally {
        await this.#disposeSession(session).catch(this.#onError);
      }
    });

    const httpServer = app.listen(
      configuredPort,
      this.#endpoint.host,
    );
    await listen(httpServer);
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      httpServer.close();
      throw new Error("Loopback MCP server returned an invalid address.");
    }
    this.#httpServer = httpServer;
    this.#url = new URL(
      `http://${LOOPBACK_HOST}:${address.port}/mcp`,
    );
    const sweepIntervalMs = Math.max(
      MIN_SESSION_IDLE_TIMEOUT_MS,
      Math.min(
        60_000,
        Math.floor(this.#sessionIdleTimeoutMs / 2),
      ),
    );
    this.#sessionSweepTimer = setInterval(() => {
      this.#sweepIdleSessions();
    }, sweepIntervalMs);
    this.#sessionSweepTimer.unref();
    return new URL(this.#url);
  }

  async close(): Promise<void> {
    const server = this.#httpServer;
    this.#httpServer = undefined;
    this.#url = undefined;
    if (this.#sessionSweepTimer) {
      clearInterval(this.#sessionSweepTimer);
      this.#sessionSweepTimer = undefined;
    }
    const sessions = [...this.#allSessions];
    this.#sessions.clear();
    this.#allSessions.clear();
    await Promise.all(
      sessions.map((session) =>
        this.#disposeSession(session).catch(this.#onError),
      ),
    );
    if (!server) {
      return;
    }
    server.closeIdleConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  #createSession(configuredPort: number): LoopbackMcpSession {
    const protocol = createParilkaMcpServer(this.#registry);
    const port = this.#url?.port || String(configuredPort);
    let session!: LoopbackMcpSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        session.sessionId = sessionId;
        this.#sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        this.#sessions.delete(sessionId);
      },
      enableDnsRebindingProtection: true,
      allowedHosts: [
        `${LOOPBACK_HOST}:${port}`,
        `localhost:${port}`,
      ],
      allowedOrigins: [
        `http://${LOOPBACK_HOST}:${port}`,
        `http://localhost:${port}`,
      ],
    });
    session = {
      protocol,
      transport,
      activeRequests: 0,
      lastActivityAtMs: Date.now(),
    };
    this.#allSessions.add(session);
    return session;
  }

  #sweepIdleSessions(nowMs = Date.now()): void {
    for (const session of this.#allSessions) {
      if (
        session.activeRequests === 0 &&
        nowMs - session.lastActivityAtMs >=
          this.#sessionIdleTimeoutMs
      ) {
        void this.#disposeSession(session).catch(this.#onError);
      }
    }
  }

  async #disposeSession(
    session: LoopbackMcpSession,
  ): Promise<void> {
    if (session.closing) {
      return await session.closing;
    }
    if (
      session.sessionId &&
      this.#sessions.get(session.sessionId) === session
    ) {
      this.#sessions.delete(session.sessionId);
    }
    this.#allSessions.delete(session);
    session.closing = session.protocol.close();
    return await session.closing;
  }
}

function listen(server: NodeHttpServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

function methodNotAllowed(): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  };
}

function requestSessionId(request: Request): string | undefined {
  const raw = request.headers["mcp-session-id"];
  return typeof raw === "string" && raw.length > 0
    ? raw
    : undefined;
}

function missingSession(): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "MCP session is required.",
    },
    id: null,
  };
}

function invalidSession(): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: "MCP session is invalid or expired.",
    },
    id: null,
  };
}

function sessionCapacityReached(): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32003,
      message: "MCP loopback session capacity is reached.",
    },
    id: null,
  };
}

function requestOriginAllowed(
  request: Request,
  serverUrl: URL | undefined,
  configuredPort: number,
): boolean {
  const origin = request.headers.origin;
  if (origin == null) {
    return true;
  }
  if (typeof origin !== "string") {
    return false;
  }
  const port = serverUrl?.port || String(configuredPort);
  return (
    origin === `http://${LOOPBACK_HOST}:${port}` ||
    origin === `http://localhost:${port}`
  );
}

function forbiddenOrigin(): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32002,
      message: "Origin is not allowed.",
    },
    id: null,
  };
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  name: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new RangeError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}
