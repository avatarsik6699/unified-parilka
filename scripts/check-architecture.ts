import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCTION_LINE_CEILING = 700;
const TEST_LINE_CEILING = 500;
const BARREL_LINE_CEILING = 150;

const thinBarrels = [
  "src/bot-daemon.ts",
  "src/index.ts",
  "src/sync-daemon.ts",
  "src/bot/output-guards.ts",
  "src/bot/read-tools.ts",
  "src/bot/runtime.ts",
  "src/bot/runtime-config.ts",
  "src/bot/turn-coordinator.ts",
  "src/bot/worker.ts",
  "src/config.ts",
  "src/digests.ts",
  "src/providers/model-router.ts",
  "src/store.ts",
  "src/sync-engine.ts",
  "src/telegram/mtcute-client.ts",
  "src/tools.ts",
  "src/vector-rag.ts",
];

const requiredPaths = [
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
];

const forbiddenRootTodos = [
  "ARCHITECTURE_TODO.md",
  "NEXT_ARCHITECTURE_TODO.md",
  "NEXT_CODEX_GOAL.md",
];

const documentationRoots = [
  ".agents",
  "codex-skill",
  "docs",
  "loop-develop",
  "operations",
  "src",
];

const deprecatedOperatorReferences = [
  "/root/telegram-parilka-mcp",
  "telegram-parilka-mcp-sync.service",
];

export type ArchitectureFinding = {
  code:
    | "active-goal-count"
    | "barrel-too-large"
    | "broken-doc-link"
    | "deprecated-operator-reference"
    | "forbidden-root-todo"
    | "missing-required-path"
    | "production-file-too-large"
    | "test-file-too-large";
  file: string;
  message: string;
};

export type ArchitectureCheck = {
  findings: ArchitectureFinding[];
  productionFiles: number;
  testFiles: number;
};

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(candidate);
    }
    return entry.isFile() ? [candidate] : [];
  });
}

export function countSourceLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function checkArchitecture(repositoryRoot = process.cwd()): ArchitectureCheck {
  const findings: ArchitectureFinding[] = [];
  const productionFiles = ["src", "scripts"].flatMap((relative) =>
    listFiles(path.join(repositoryRoot, relative)).filter((file) =>
      file.endsWith(".ts"),
    ),
  );

  for (const file of productionFiles) {
    const lines = countSourceLines(readFileSync(file, "utf8"));
    if (lines > PRODUCTION_LINE_CEILING) {
      const relative = path.relative(repositoryRoot, file);
      findings.push({
        code: "production-file-too-large",
        file: relative,
        message: `${relative} has ${lines} lines; ceiling is ${PRODUCTION_LINE_CEILING}`,
      });
    }
  }

  const testFiles = listFiles(path.join(repositoryRoot, "tests")).filter(
    (file) => file.endsWith(".ts"),
  );
  for (const file of testFiles) {
    const lines = countSourceLines(readFileSync(file, "utf8"));
    if (lines > TEST_LINE_CEILING) {
      const relative = path.relative(repositoryRoot, file);
      findings.push({
        code: "test-file-too-large",
        file: relative,
        message: `${relative} has ${lines} lines; test ceiling is ${TEST_LINE_CEILING}`,
      });
    }
  }

  for (const relative of thinBarrels) {
    const file = path.join(repositoryRoot, relative);
    if (!existsSync(file)) {
      continue;
    }
    const lines = countSourceLines(readFileSync(file, "utf8"));
    if (lines > BARREL_LINE_CEILING) {
      findings.push({
        code: "barrel-too-large",
        file: relative,
        message: `${relative} has ${lines} lines; thin-barrel ceiling is ${BARREL_LINE_CEILING}`,
      });
    }
  }

  for (const relative of requiredPaths) {
    if (!existsSync(path.join(repositoryRoot, relative))) {
      findings.push({
        code: "missing-required-path",
        file: relative,
        message: `${relative} is required by the repository documentation contract`,
      });
    }
  }

  checkRootDocLinks(repositoryRoot, findings);

  for (const relative of forbiddenRootTodos) {
    if (existsSync(path.join(repositoryRoot, relative))) {
      findings.push({
        code: "forbidden-root-todo",
        file: relative,
        message: `${relative} must live in loop-develop/current-todo or history`,
      });
    }
  }

  const documentationFiles = [
    "AGENTS.md",
    "README.md",
    "llms.txt",
    ...documentationRoots.flatMap((relative) =>
      listFiles(path.join(repositoryRoot, relative))
        .filter((file) => file.endsWith(".md"))
        .map((file) => path.relative(repositoryRoot, file)),
    ),
  ].filter((relative, index, all) => all.indexOf(relative) === index);

  for (const relative of documentationFiles) {
    const file = path.join(repositoryRoot, relative);
    if (!existsSync(file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const target of localMarkdownLinkTargets(text)) {
      if (!existsSync(path.resolve(path.dirname(file), target))) {
        findings.push({
          code: "broken-doc-link",
          file: relative,
          message: `${relative} links to missing local path ${target}`,
        });
      }
    }
    for (const reference of deprecatedOperatorReferences) {
      if (text.includes(reference)) {
        findings.push({
          code: "deprecated-operator-reference",
          file: relative,
          message: `${relative} contains retired operator reference ${reference}`,
        });
      }
    }
  }

  const currentTodoRoot = path.join(
    repositoryRoot,
    "loop-develop",
    "current-todo",
  );
  const activeGoals = listFiles(currentTodoRoot).filter(
    (file) =>
      path.dirname(file) === currentTodoRoot &&
      /^\d{3}-todo\.md$/u.test(path.basename(file)),
  );
  if (activeGoals.length > 1) {
    findings.push({
      code: "active-goal-count",
      file: path.relative(repositoryRoot, currentTodoRoot),
      message: `found ${activeGoals.length} active goal records; at most one is allowed`,
    });
  }

  return {
    findings,
    productionFiles: productionFiles.length,
    testFiles: testFiles.length,
  };
}

export function localMarkdownLinkTargets(text: string): string[] {
  const targets: string[] = [];
  const links = text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g);
  for (const match of links) {
    const raw = match[1];
    if (raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
      continue;
    }
    const withoutAnchor = raw.split("#", 1)[0];
    if (withoutAnchor.length > 0) {
      targets.push(decodeURIComponent(withoutAnchor));
    }
  }
  return targets;
}

function checkRootDocLinks(
  repositoryRoot: string,
  findings: ArchitectureFinding[],
): void {
  for (const relative of ["AGENTS.md", "llms.txt"]) {
    const file = path.join(repositoryRoot, relative);
    if (!existsSync(file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const target of localMarkdownLinkTargets(text)) {
      if (!existsSync(path.resolve(path.dirname(file), target))) {
        findings.push({
          code: "broken-doc-link",
          file: relative,
          message: `${relative} links to missing local path ${target}`,
        });
      }
    }
  }
}

function main(): void {
  const result = checkArchitecture();
  if (result.findings.length > 0) {
    for (const finding of result.findings) {
      console.error(`${finding.code}: ${finding.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        productionFiles: result.productionFiles,
        testFiles: result.testFiles,
        productionLineCeiling: PRODUCTION_LINE_CEILING,
        testLineCeiling: TEST_LINE_CEILING,
        thinBarrelLineCeiling: BARREL_LINE_CEILING,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
