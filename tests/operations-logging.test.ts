import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const TURN_FILTER =
  "(.MESSAGE? | fromjson?) as $event | select($event.turnId == $turnId) | $event";

test("operations turn recipe parses outer journald MESSAGE and matches numeric turnId", () => {
  const matching = {
    event: "bot.agent.tool_started",
    turnId: 42,
    updateId: 73,
    candidate: "primary:test",
    attempt: 1,
    tool: "rag_bm25_search",
    kind: "read",
    sequence: 1,
  };
  const outerRecords = [
    { MESSAGE: JSON.stringify(matching) },
    { MESSAGE: JSON.stringify({ ...matching, turnId: "42" }) },
    { MESSAGE: "not application JSON" },
  ];
  const result = spawnSync(
    "jq",
    ["--compact-output", "--argjson", "turnId", "42", TURN_FILTER],
    {
      input: `${outerRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      encoding: "utf8",
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), matching);
});
