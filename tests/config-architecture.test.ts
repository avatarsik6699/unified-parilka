import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const configRoot = path.join(
  repositoryRoot,
  "src",
  "config",
);

function sourceLines(text: string): number {
  const lines = text.split(/\r?\n/u);
  return lines.at(-1) === ""
    ? lines.length - 1
    : lines.length;
}

test("config facade stays thin and bootstraps env files first", () => {
  const facade = readFileSync(
    path.join(repositoryRoot, "src", "config.ts"),
    "utf8",
  );
  assert.ok(
    sourceLines(facade) <= 150,
    "src/config.ts must remain a thin public facade",
  );
  assert.ok(
    facade.indexOf('import "./config/env-files.js";') >= 0 &&
      facade.indexOf('import "./config/env-files.js";') <
        facade.indexOf("export "),
    "the public facade must bootstrap dotenv precedence before its exports",
  );

  const loader = readFileSync(
    path.join(configRoot, "load.ts"),
    "utf8",
  );
  assert.match(
    loader,
    /^import "\.\/env-files\.js";/u,
    "direct internal use of load.ts must retain the same env bootstrap",
  );
});

test("config concerns remain split into reviewable modules", () => {
  const files = readdirSync(configRoot, {
    withFileTypes: true,
  }).filter(
    (entry) =>
      entry.isFile() && entry.name.endsWith(".ts"),
  );
  const names = files.map((entry) => entry.name);
  for (const required of [
    "env-files.ts",
    "env-parsers.ts",
    "env-rules.ts",
    "load.ts",
    "paths.ts",
    "redaction.ts",
    "types.ts",
    "validation.ts",
  ]) {
    assert.ok(
      names.includes(required),
      `src/config/${required} is required`,
    );
  }

  for (const entry of files) {
    const text = readFileSync(
      path.join(configRoot, entry.name),
      "utf8",
    );
    assert.ok(
      sourceLines(text) <= 350,
      `${entry.name} exceeds the config module ceiling of 350 lines`,
    );
  }
});
