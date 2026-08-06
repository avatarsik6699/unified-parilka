import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GENERIC_PUBLIC_ERROR_MESSAGE,
  ToolError,
} from "../src/errors.js";
import { toolFailure } from "../src/mcp-tools/response.js";
import { MessageStore } from "../src/store.js";
import {
  callTool,
  configuredEmbeddingsConfig,
  makeTools,
  parseToolPayload,
} from "./support/tools-response.js";

test("invalid tool arguments return validation fields", async () => {
  const tools = makeTools();
  const result = await callTool(tools, "read_history", {
    limit: "bad",
  });

  assert.equal(result.ok, false);
  const error = result.error as { category: string; fields?: Array<{ path: string }> };
  assert.equal(error.category, "validation");
  assert.equal(error.fields?.[0]?.path, "limit");
});

test("failed tool results set MCP isError while preserving JSON payload", async () => {
  const tools = makeTools();
  const failure = await tools.callTool("read_history", {
    limit: "bad",
  });
  const failurePayload = parseToolPayload(failure);

  assert.equal(failure.isError, true);
  assert.equal(failurePayload.ok, false);
  assert.equal((failurePayload.error as { category: string }).category, "validation");

  const success = await tools.callTool("get_config", {});
  const successPayload = parseToolPayload(success);

  assert.equal(success.isError, undefined);
  assert.equal(successPayload.ok, true);
});

test("generic MCP failures never serialize upstream error text", () => {
  const marker = "UPSTREAM_RAW_BODY_WITHOUT_URL";
  const failure = toolFailure(
    new Error(
      `${marker} https://user:pass@provider.test/v1?api_key=unit-marker Bearer unit-marker`,
    ),
  );
  const text = failure.content[0]!.text;
  const payload = parseToolPayload(failure);
  const error = payload.error as {
    category: string;
    retryable: boolean;
    message: string;
  };

  assert.equal(failure.isError, true);
  assert.equal(error.category, "internal");
  assert.equal(error.retryable, false);
  assert.equal(error.message, GENERIC_PUBLIC_ERROR_MESSAGE);
  assert.doesNotMatch(text, new RegExp(marker));
  assert.doesNotMatch(text, /provider\.test|Bearer unit-marker/u);

  const wrapped = toolFailure(
    new ToolError({
      category: "internal",
      retryable: true,
      message: `${marker} from a wrapped provider failure`,
    }),
  );
  assert.equal(
    (parseToolPayload(wrapped).error as { message: string }).message,
    GENERIC_PUBLIC_ERROR_MESSAGE,
  );
  assert.doesNotMatch(wrapped.content[0]!.text, new RegExp(marker));

  const safeLocalFailure = toolFailure(
    new ToolError({
      category: "permission",
      retryable: false,
      message: "Live send requires approval_id from preview_message.",
    }),
  );
  assert.equal(
    (parseToolPayload(safeLocalFailure).error as { message: string }).message,
    "Live send requires approval_id from preview_message.",
  );
});

test("get_config redacts credentials in embeddings base URL", async () => {
  const appConfig = configuredEmbeddingsConfig({
    baseUrl: "https://user:pass@example.test/v1?api_key=x&foo=bar&token=y&KEY=z",
  });
  const result = await callTool(makeTools(new MessageStore(":memory:"), appConfig), "get_config", {});
  const config = result.config as { embeddings: { baseUrl: string } };

  assert.equal(config.embeddings.baseUrl, "https://example.test/v1?api_key=redacted&foo=bar&token=redacted&KEY=redacted");
});

test("get_config reports the local BGE-M3 backend without an OpenAI endpoint", async () => {
  const appConfig = configuredEmbeddingsConfig({
    backend: "local_bge_m3",
    apiKey: "",
    localEndpoint: "http://127.0.0.1:8767",
    model: "bge-m3",
    dimensions: 1024,
    localRequestTimeoutMs: 15_000,
    rerankTimeoutMs: 5_000,
    rerankMaxCandidates: 16,
  });
  const result = await callTool(makeTools(new MessageStore(":memory:"), appConfig), "get_config", {});
  const embeddings = (result.config as { embeddings: Record<string, unknown> }).embeddings;

  assert.equal(embeddings.backend, "local_bge_m3");
  assert.equal(embeddings.configured, true);
  assert.equal(embeddings.localEndpoint, "http://127.0.0.1:8767/");
  assert.equal(embeddings.localRequestTimeoutMs, 15_000);
  assert.equal(embeddings.rerankTimeoutMs, 5_000);
  assert.equal(embeddings.rerankMaxCandidates, 16);
  assert.equal(embeddings.model, "bge-m3");
  assert.equal(embeddings.dimensions, 1024);
  assert.equal("baseUrl" in embeddings, false);
  assert.equal("requestTimeoutMs" in embeddings, false);
  assert.doesNotMatch(JSON.stringify(result), /api\.openai\.com/u);
});

test("get_config redacts credentials in the local endpoint", async () => {
  const appConfig = configuredEmbeddingsConfig({
    backend: "local_bge_m3",
    apiKey: "",
    localEndpoint: "http://user:pass@127.0.0.1:8767",
  });
  const result = await callTool(makeTools(new MessageStore(":memory:"), appConfig), "get_config", {});
  const embeddings = (result.config as { embeddings: Record<string, unknown> }).embeddings;

  assert.equal(embeddings.localEndpoint, "http://127.0.0.1:8767/");
  assert.doesNotMatch(JSON.stringify(result), /user:pass/u);
});

test("get_config keeps the external backend shape and key-driven configured", async () => {
  const configured = await callTool(
    makeTools(new MessageStore(":memory:"), configuredEmbeddingsConfig()),
    "get_config",
    {},
  );
  const external = (configured.config as { embeddings: Record<string, unknown> }).embeddings;

  assert.equal(external.backend, "external_openai");
  assert.equal(external.configured, true);
  assert.equal(external.baseUrl, "https://api.openai.com/v1");
  assert.equal(external.requestTimeoutMs, 60_000);
  assert.equal("localEndpoint" in external, false);

  const unconfigured = await callTool(
    makeTools(new MessageStore(":memory:"), configuredEmbeddingsConfig({ apiKey: "" })),
    "get_config",
    {},
  );
  const missingKey = (unconfigured.config as { embeddings: Record<string, unknown> }).embeddings;

  assert.equal(missingKey.backend, "external_openai");
  assert.equal(missingKey.configured, false);
});

test("get_status names the active embedding backend and configured state", async () => {
  const localConfig = configuredEmbeddingsConfig({
    backend: "local_bge_m3",
    apiKey: "",
    localEndpoint: "http://127.0.0.1:8767",
    model: "bge-m3",
    dimensions: 1024,
  });
  const local = parseToolPayload(
    await makeTools(new MessageStore(":memory:"), localConfig).callTool("get_status", {}),
  );
  const localEmbeddings = local.embeddings as { backend: string; configured: boolean };

  assert.equal(localEmbeddings.backend, "local_bge_m3");
  assert.equal(localEmbeddings.configured, true);

  const external = parseToolPayload(
    await makeTools(new MessageStore(":memory:"), configuredEmbeddingsConfig()).callTool("get_status", {}),
  );
  const externalEmbeddings = external.embeddings as { backend: string; configured: boolean };

  assert.equal(externalEmbeddings.backend, "external_openai");
  assert.equal(externalEmbeddings.configured, true);

  const missingKey = parseToolPayload(
    await makeTools(new MessageStore(":memory:"), configuredEmbeddingsConfig({ apiKey: "" })).callTool("get_status", {}),
  );
  const unconfiguredEmbeddings = missingKey.embeddings as { backend: string; configured: boolean };

  assert.equal(unconfiguredEmbeddings.backend, "external_openai");
  assert.equal(unconfiguredEmbeddings.configured, false);
});

test("unknown tool arguments return validation field paths", async () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; path: string }> = [
    { tool: "get_config", args: { extra: true }, path: "extra" },
    { tool: "read_history", args: { befor_id: 10 }, path: "befor_id" },
    { tool: "sync_history", args: { mode: "recent", limt: 10 }, path: "limt" },
    { tool: "search_messages", args: { query: "needle", vector_limt: 5 }, path: "vector_limt" },
    { tool: "index_embeddings", args: { confirm: true }, path: "confirm" },
    { tool: "preview_message", args: { text: "hello", user_key: "caller" }, path: "user_key" },
    { tool: "send_message", args: { text: "hello", user_key: "caller" }, path: "user_key" },
  ];

  for (const item of cases) {
    const result = await callTool(makeTools(), item.tool, item.args);
    assert.equal(result.ok, false, item.tool);
    const error = result.error as { category: string; fields?: Array<{ path: string }> };
    assert.equal(error.category, "validation", item.tool);
    assert.equal(error.fields?.some((field) => field.path === item.path), true, item.tool);
  }
});

test("numeric tool schemas use JSON Schema integer", () => {
  const tools = makeTools();
  const sync = tools.listTools().find((tool) => tool.name === "sync_history");
  const props = sync?.inputSchema.properties as Record<string, Record<string, unknown>>;

  assert.equal(props.limit.type, "integer");
  assert.equal(props.batch_size.type, "integer");
  assert.equal(props.offset_id.type, "integer");
});

test("tool JSON schemas reject additional properties", () => {
  const tools = makeTools();

  for (const tool of tools.listTools()) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
});
