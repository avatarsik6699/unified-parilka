import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type SecretPattern = {
  name: string;
  regex: RegExp;
};

export type SecretFinding = { file: string; line: number; pattern: string };

export const patterns: SecretPattern[] = [
  {
    name: "API key assignment",
    regex:
      /\b(?:[A-Z0-9_]*(?:ANTHROPIC|DASHSCOPE|DEEPSEEK|GEMINI|GOOGLE|OPENAI)[A-Z0-9_]*|[A-Z0-9_]*API_KEY)\s*[:=]\s*['"]?(?!example|placeholder|test|your[-_])(?:sk[-_])?[A-Za-z0-9._-]{20,}/i,
  },
  {
    name: "Telegram API hash",
    regex: /\bTELEGRAM_API_HASH\s*[:=]\s*['"]?[a-f0-9]{32}\b/i,
  },
  {
    name: "Telegram StringSession",
    regex: /\b(?:TELEGRAM_SESSION|TELEGRAM_SESSION_STRING(?:_[A-Z0-9_]+)?|SESSION)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{80,}/,
  },
  {
    name: "Private key block",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    name: "Telegram bot token",
    regex:
      /\b[A-Z0-9_]*BOT_TOKEN\s*[:=]\s*['"]?\d{6,}:[A-Za-z0-9_-]{35,}/i,
  },
  {
    name: "GitHub token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  },
  {
    name: "AWS access key",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    name: "AWS secret key assignment",
    regex: /\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}\b/i,
  },
  {
    name: "Bearer or JWT assignment",
    regex:
      /\b(?:AUTHORIZATION|BEARER_TOKEN|JWT|JWT_TOKEN)\s*[:=]\s*['"]?(?:Bearer\s+)?(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[A-Za-z0-9._-]{32,})/i,
  },
  {
    name: "Google API key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    name: "Slack token",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  },
  {
    name: "High-entropy hex secret",
    regex: /\b[a-f0-9]{32}\b/,
  },
];

export function listGitScannableFiles(): string[] {
  const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "buffer",
  });

  if (git.status !== 0) {
    process.stderr.write(git.stderr);
    process.exit(git.status ?? 1);
  }

  return git.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter(isScannableFile);
}

export function isScannableFile(file: string): boolean {
  return !file.endsWith(".png") && !file.endsWith(".jpg") && !file.endsWith(".jpeg") && !file.endsWith(".gif");
}

const HEX32_HASH_ASSIGNMENT =
  /(?:^|[^a-zA-Z0-9])(?:hash|sha|commit|tree|parent|checksum|digest|fingerprint|etag|revision)\s*[:=]\s*['"]?[a-f0-9]{32}\b/i;

export function scanSecretText(file: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const pattern of patterns) {
      if (pattern.name === "High-entropy hex secret" && HEX32_HASH_ASSIGNMENT.test(line)) {
        continue;
      }
      if (pattern.regex.test(line)) {
        findings.push({ file, line: index + 1, pattern: pattern.name });
      }
    }
  }
  return findings;
}

export function scanSecretFiles(files: string[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanSecretText(file, text));
  }
  return findings;
}

export function formatSecretFindings(findings: SecretFinding[]): string {
  const lines = ["Potential secrets found. Values are intentionally redacted:"];
  for (const finding of findings) {
    lines.push(`${finding.file}:${finding.line} ${finding.pattern}`);
  }
  return lines.join("\n");
}

export function secretScanSummary(files = listGitScannableFiles()): {
  ok: true;
  scannedFiles: number;
  patterns: string[];
} {
  return {
    ok: true,
    scannedFiles: files.length,
    patterns: patterns.map((pattern) => pattern.name),
  };
}

function main(): void {
  const files = listGitScannableFiles();
  const findings = scanSecretFiles(files);

  if (findings.length > 0) {
    console.error(formatSecretFindings(findings));
    process.exit(1);
  }

  console.log(JSON.stringify(secretScanSummary(files), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
