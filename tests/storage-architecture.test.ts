import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const storageRoot = path.join(repositoryRoot, "src", "storage");

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return typescriptFiles(candidate);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [candidate] : [];
  });
}

test("storage decomposition keeps one SQLite and transaction owner", () => {
  const storePath = path.join(repositoryRoot, "src", "store.ts");
  const files = [storePath, ...typescriptFiles(storageRoot)];
  const sources = files.map((file) => ({
    file,
    text: readFileSync(file, "utf8"),
  }));

  assert.ok(
    sources.find(({ file }) => file === storePath)!.text.split("\n").length <=
      150,
    "src/store.ts must remain a small compatibility barrel",
  );
  for (const { file, text } of sources) {
    assert.ok(
      text.split("\n").length <= 700,
      `${path.relative(repositoryRoot, file)} exceeds the 700-line ceiling`,
    );
  }

  const connectionOwners = sources.filter(({ text }) =>
    text.includes("new DatabaseSync("),
  );
  assert.deepEqual(
    connectionOwners.map(({ file }) => path.relative(repositoryRoot, file)),
    ["src/storage/core.ts"],
  );

  const transactionOwners = sources.filter(({ text }) =>
    text.includes('this.db.exec("BEGIN IMMEDIATE")'),
  );
  assert.deepEqual(
    transactionOwners.map(({ file }) => path.relative(repositoryRoot, file)),
    ["src/storage/core.ts"],
  );
});
