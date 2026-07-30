import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkArchitecture,
  countSourceLines,
  localMarkdownLinkTargets,
} from "../scripts/check-architecture.js";

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "parilka-architecture-"));
  try {
    for (const directory of [
      ".agents/rules",
      "codex-skill/telegram-parilka-mcp",
      "docs/adr",
      "loop-develop/current-todo",
      "operations",
      "src",
      "tests",
    ]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    for (const file of [
      ".agents/rules/README.md",
      ".agents/rules/documentation.md",
      "AGENTS.md",
      "codex-skill/telegram-parilka-mcp/SKILL.md",
      "docs/README.md",
      "docs/architecture.md",
      "docs/adr/README.md",
      "llms.txt",
      "loop-develop/README.md",
      "operations/README.md",
      "operations/MIGRATION.md",
    ]) {
      writeFileSync(path.join(root, file), "# fixture\n");
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("source line counting ignores one terminal newline", () => {
  assert.equal(countSourceLines(""), 0);
  assert.equal(countSourceLines("one"), 1);
  assert.equal(countSourceLines("one\n"), 1);
  assert.equal(countSourceLines("one\ntwo\n"), 2);
});

test("documentation link parser keeps only local file targets", () => {
  assert.deepEqual(
    localMarkdownLinkTargets(
      "[local](../README.md#usage) [web](https://example.com) [anchor](#top)",
    ),
    ["../README.md"],
  );
});

test("architecture check accepts bounded source and one active goal", () => {
  withFixture((root) => {
    writeFileSync(path.join(root, "src", "bounded.ts"), "export {};\n");
    writeFileSync(
      path.join(root, "loop-develop", "current-todo", "001-todo.md"),
      "# active\n",
    );

    assert.deepEqual(checkArchitecture(root), {
      findings: [],
      productionFiles: 1,
      testFiles: 0,
    });
  });
});

test("architecture check rejects monsters and multiple active goals", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "src", "monster.ts"),
      `${"const value = 1;\n".repeat(701)}`,
    );
    writeFileSync(
      path.join(root, "loop-develop", "current-todo", "001-todo.md"),
      "# first\n",
    );
    writeFileSync(
      path.join(root, "loop-develop", "current-todo", "002-todo.md"),
      "# second\n",
    );

    const result = checkArchitecture(root);
    assert.deepEqual(
      result.findings.map((finding) => finding.code).sort(),
      ["active-goal-count", "production-file-too-large"],
    );
  });
});

test("architecture check rejects a mixed test monster", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "tests", "monster.test.ts"),
      `${"test('case', () => {});\n".repeat(501)}`,
    );

    const result = checkArchitecture(root);
    assert.equal(result.findings[0]?.code, "test-file-too-large");
  });
});

test("architecture check rejects a broken local documentation link", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "docs", "README.md"),
      "[missing](does-not-exist.md)\n",
    );

    assert.equal(checkArchitecture(root).findings[0]?.code, "broken-doc-link");
  });
});

test("architecture check rejects retired operator instructions", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "codex-skill", "telegram-parilka-mcp", "SKILL.md"),
      "Run /root/telegram-parilka-mcp and telegram-parilka-mcp-sync.service\n",
    );

    assert.deepEqual(
      checkArchitecture(root).findings.map((finding) => finding.code),
      ["deprecated-operator-reference", "deprecated-operator-reference"],
    );
  });
});
