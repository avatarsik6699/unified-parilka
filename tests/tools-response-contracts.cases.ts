import assert from "node:assert/strict";
import { test } from "node:test";
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

test("get_config redacts credentials in embeddings base URL", async () => {
  const appConfig = configuredEmbeddingsConfig({
    baseUrl: "https://user:pass@example.test/v1?api_key=x&foo=bar&token=y&KEY=z",
  });
  const result = await callTool(makeTools(new MessageStore(":memory:"), appConfig), "get_config", {});
  const config = result.config as { embeddings: { baseUrl: string } };

  assert.equal(config.embeddings.baseUrl, "https://example.test/v1?api_key=redacted&foo=bar&token=redacted&KEY=redacted");
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
