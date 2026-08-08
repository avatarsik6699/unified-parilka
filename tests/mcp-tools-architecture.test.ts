import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  listToolDefinitions,
  TOOL_NAMES,
} from "../src/mcp-tools/definitions.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("MCP facade and explicit registry expose exactly the fixed 18 tools", () => {
  const expected = [
    "get_config",
    "get_status",
    "resolve_chat",
    "get_chat_info",
    "sync_history",
    "read_history",
    "search_messages",
    "semantic_search_messages",
    "index_embeddings",
    "get_thread_context",
    "preview_message",
    "send_message",
    "reply_to_message",
    "rag_bm25_search",
    "keyword_search",
    "read_chat_slice",
    "day_digest",
    "thread_context",
  ];
  assert.deepEqual([...TOOL_NAMES], expected);
  assert.deepEqual(
    listToolDefinitions().map(({ name }) => name),
    expected,
  );
  assert.equal(new Set(TOOL_NAMES).size, 18);

  const registry = readFileSync(
    path.join(
      repositoryRoot,
      "src",
      "mcp-tools",
      "registry.ts",
    ),
    "utf8",
  );
  const branches = [
    ...registry.matchAll(/case "([^"]+)":/gu),
  ].map((match) => match[1]);
  assert.deepEqual(branches, expected);
});

test("MCP tool decomposition keeps a thin compatibility facade", () => {
  const facade = readFileSync(
    path.join(repositoryRoot, "src", "tools.ts"),
    "utf8",
  );
  assert.ok(facade.split("\n").length <= 150);

  const directory = path.join(
    repositoryRoot,
    "src",
    "mcp-tools",
  );
  for (const entry of readdirSync(directory, {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const text = readFileSync(
      path.join(directory, entry.name),
      "utf8",
    );
    assert.ok(
      text.split("\n").length <= 700,
      `${entry.name} exceeds the 700-line ceiling`,
    );
  }
});
