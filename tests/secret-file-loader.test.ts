import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const loader = path.join(
  repositoryRoot,
  "bin",
  "parilka-secret-env",
);

function withSecret(
  mode: number,
  run: (path: string) => void,
): void {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "parilka-secret-loader-"),
  );
  try {
    const secretPath = path.join(directory, "credential");
    writeFileSync(secretPath, "fixture-value\n", { mode });
    chmodSync(secretPath, mode);
    run(secretPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runLoader(secretPath: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -e",
        'source "$1"',
        "TEST_SECRET_FILE=$2",
        "parilka_load_secret_file TEST_SECRET TEST_SECRET_FILE",
        'printf "%s" "${#TEST_SECRET}"',
      ].join("\n"),
      "parilka-secret-test",
      loader,
      secretPath,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
      },
    },
  );
}

test("secret-file loader exports one-line values without printing them", () => {
  withSecret(0o600, (secretPath) => {
    const result = runLoader(secretPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, String("fixture-value".length));
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /fixture-value/u,
    );
  });
});

test("secret-file loader rejects group/world-readable credentials", () => {
  withSecret(0o644, (secretPath) => {
    const result = runLoader(secretPath);
    assert.equal(result.status, 78);
    assert.match(result.stderr, /0400 or 0600/u);
    assert.doesNotMatch(result.stderr, /fixture-value/u);
  });
});

test("secret-file loader rejects more than one line", () => {
  withSecret(0o600, (secretPath) => {
    writeFileSync(secretPath, "first\nsecond\n", { mode: 0o600 });
    const result = runLoader(secretPath);
    assert.equal(result.status, 78);
    assert.match(result.stderr, /empty or not one line/u);
    assert.doesNotMatch(result.stderr, /first|second/u);
  });
});
