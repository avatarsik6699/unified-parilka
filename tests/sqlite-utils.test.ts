import assert from "node:assert/strict";
import { test } from "node:test";
import { toSqlValues } from "../src/storage/sqlite-utils.js";

test("SQLite bind conversion preserves supported scalar and binary values", () => {
  const binary = new Uint8Array([1, 2, 3]);
  const values = toSqlValues([null, "text", 7, 8n, binary]);

  assert.equal(values[0], null);
  assert.equal(values[1], "text");
  assert.equal(values[2], 7);
  assert.equal(values[3], 8n);
  assert.equal(values[4], binary);
});

test("SQLite bind conversion rejects objects before they reach DatabaseSync", () => {
  assert.throws(
    () => toSqlValues([{ injected: "value" }]),
    /SQLite bind values must be scalar or binary values/u,
  );
});
