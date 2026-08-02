import { lookup as dnsLookup } from "node:dns/promises";
import { type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type {
  BotReadToolSuccess,
  ReadToolEvidence,
  WebFetchProvider,
  WebFetchResponse,
} from "./contracts.js";
import {
  ReadToolExecutionError,
  success,
} from "./payload.js";
import {
  webFetchResponseSchema,
  type WebFetchArgs,
} from "./schemas.js";
import { callWebFetchProvider } from "./timeouts.js";

export const DEFAULT_WEB_FETCH_TIMEOUT_MS = 30_000;
const MAX_WEB_FETCH_RESPONSE_BYTES = 1_000_000;
const WEB_FETCH_ACCEPT =
  "text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.5";
type Ipv6Prefix = readonly [readonly number[], number];

// Static snapshot of IANA's IPv6 unicast allocation table. Unlisted space
// fails closed rather than assuming every address in a global-unicast block is
// public. Special-purpose destinations are rejected separately below.
const ALLOCATED_PUBLIC_IPV6_PREFIXES: readonly Ipv6Prefix[] = [
  [[0x2001, 0x0000], 23], [[0x2001, 0x0200], 23],
  [[0x2001, 0x0400], 23], [[0x2001, 0x0600], 23],
  [[0x2001, 0x0800], 22], [[0x2001, 0x0c00], 23],
  [[0x2001, 0x0e00], 23], [[0x2001, 0x1200], 23],
  [[0x2001, 0x1400], 22], [[0x2001, 0x1800], 23],
  [[0x2001, 0x1a00], 23], [[0x2001, 0x1c00], 22],
  [[0x2001, 0x2000], 19], [[0x2001, 0x4000], 23],
  [[0x2001, 0x4200], 23], [[0x2001, 0x4400], 23],
  [[0x2001, 0x4600], 23], [[0x2001, 0x4800], 23],
  [[0x2001, 0x4a00], 23], [[0x2001, 0x4c00], 23],
  [[0x2001, 0x5000], 20], [[0x2001, 0x8000], 19],
  [[0x2001, 0xa000], 20], [[0x2001, 0xb000], 20],
  [[0x2002], 16], [[0x2003, 0x0000], 18],
  [[0x2400], 12], [[0x2410], 12], [[0x2600], 12],
  [[0x2610, 0x0000], 23], [[0x2620, 0x0000], 23],
  [[0x2630], 12], [[0x2800], 12], [[0x2a00], 12],
  [[0x2a10], 12], [[0x2c00], 12],
];

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface PublicWebFetchTransportRequest {
  url: URL;
  address: ResolvedAddress;
  signal: AbortSignal;
  maxBytes: number;
}

export interface PublicWebFetchTransportResponse {
  status: number;
  statusText?: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface PublicWebFetchProviderOptions {
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  transport?: (
    request: PublicWebFetchTransportRequest,
  ) => Promise<PublicWebFetchTransportResponse>;
}

/**
 * Fetches one public page using a DNS-pinned HTTPS connection. It never shares
 * browser state, follows redirects, runs scripts, or sends credentials.
 */
export class PublicWebFetchProvider implements WebFetchProvider {
  readonly #lookup: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly #transport: (
    request: PublicWebFetchTransportRequest,
  ) => Promise<PublicWebFetchTransportResponse>;

  constructor(options: PublicWebFetchProviderOptions = {}) {
    this.#lookup = options.lookup ?? lookupPublicAddresses;
    this.#transport = options.transport ?? requestPinnedHttpsPage;
  }

  async fetch(request: {
    url: string;
    maxChars: number;
    signal: AbortSignal;
  }): Promise<WebFetchResponse> {
    const url = validatePublicHttpsUrl(request.url);
    if (request.signal.aborted) {
      throw request.signal.reason ?? new Error("Web fetch was aborted.");
    }

    const addresses = await this.#lookup(url.hostname);
    if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item))) {
      throw new ReadToolExecutionError(
        "unsafe_url",
        false,
        "Web fetch URL resolves to a private or unsupported address.",
      );
    }
    const address = addresses.find((item) => item.family === 4) ?? addresses[0]!;
    const response = await this.#transport({
      url,
      address,
      signal: request.signal,
      maxBytes: MAX_WEB_FETCH_RESPONSE_BYTES,
    });
    if (response.body.length > MAX_WEB_FETCH_RESPONSE_BYTES) {
      throw new ReadToolExecutionError(
        "provider_error",
        false,
        "Web page response exceeded the 1 MiB limit.",
      );
    }

    const status = boundedStatus(response.status);
    const statusText = boundedText(response.statusText, 200);
    const contentType = normalizedContentType(response.headers);
    const location = redirectLocation(status, response.headers, url);
    if (location !== undefined) {
      return {
        url: url.toString(),
        status,
        ...(statusText === undefined ? {} : { statusText }),
        contentType,
        byteLength: response.body.length,
        text: "",
        redirectUrl: location,
      };
    }
    if (status < 200 || status >= 300) {
      throw new ReadToolExecutionError(
        "provider_error",
        status >= 500 || status === 408 || status === 429,
        `Web page returned HTTP ${status}.`,
      );
    }
    if (!isSupportedTextContentType(contentType)) {
      throw new ReadToolExecutionError(
        "provider_error",
        false,
        "Web fetch supports only public text, HTML, Markdown, XML, or JSON pages.",
      );
    }

    const extracted = extractPageText(
      response.body.toString("utf8"),
      contentType,
      request.maxChars,
    );
    return {
      url: url.toString(),
      status,
      ...(statusText === undefined ? {} : { statusText }),
      contentType,
      byteLength: response.body.length,
      text: extracted.text,
      ...(extracted.title === undefined ? {} : { title: extracted.title }),
    };
  }
}

export async function executeWebFetch(
  provider: WebFetchProvider,
  args: WebFetchArgs,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<BotReadToolSuccess> {
  const response = await callWebFetchProvider({
    provider,
    url: args.url,
    maxChars: args.max_chars,
    timeoutMs,
    externalSignal,
  });
  const parsed = webFetchResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      "Web fetch provider returned an invalid response.",
    );
  }

  const page = parsed.data;
  const pageText = truncateText(page.text, args.max_chars);
  const evidence: ReadToolEvidence[] = [{
    source: "web",
    chat: null,
    message: null,
    speaker: { id: null, name: null },
    date: null,
    text: page.title?.trim() || page.url,
    url: page.url,
    ...(page.title === undefined ? {} : { title: page.title }),
  }];
  const result = {
    url: page.url,
    status: page.status,
    ...(page.statusText === undefined ? {} : { statusText: page.statusText }),
    contentType: page.contentType,
    byteLength: page.byteLength,
    ...(page.title === undefined ? {} : { title: page.title }),
    ...(page.redirectUrl === undefined
      ? { text: pageText }
      : { redirectUrl: page.redirectUrl }),
  };
  return success(
    "web_fetch",
    page.redirectUrl !== undefined || pageText.length === 0 ? "empty" : "done",
    result,
    evidence,
  );
}

async function lookupPublicAddresses(
  hostname: string,
): Promise<readonly ResolvedAddress[]> {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.flatMap((row) =>
    row.family === 4 || row.family === 6
      ? [{ address: row.address, family: row.family }]
      : [],
  );
}

function requestPinnedHttpsPage(
  input: PublicWebFetchTransportRequest,
): Promise<PublicWebFetchTransportResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest> | undefined;
    const onAbort = (): void => {
      request?.destroy(
        input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("Web fetch was aborted."),
      );
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const rejectOnce = (error: unknown): void => {
      settle(() => reject(error));
    };
    request = httpsRequest(
      {
        protocol: "https:",
        hostname: input.address.address,
        family: input.address.family,
        port: 443,
        method: "GET",
        path: `${input.url.pathname}${input.url.search}`,
        headers: {
          Host: input.url.host,
          Accept: WEB_FETCH_ACCEPT,
          "User-Agent": "ParilkaBot/1.0 public-page-fetch",
        },
        servername: input.url.hostname,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("data", (chunk: Buffer | Uint8Array | string) => {
          const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);
          byteLength += buffer.length;
          if (byteLength > input.maxBytes) {
            response.destroy(
              new ReadToolExecutionError(
                "provider_error",
                false,
                "Web page response exceeded the 1 MiB limit.",
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", rejectOnce);
        response.once("end", () => {
          settle(() =>
            resolve({
              status: response.statusCode ?? 0,
              ...(response.statusMessage === undefined
                ? {}
                : { statusText: response.statusMessage }),
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
        });
      },
    );
    request.once("error", rejectOnce);
    if (input.signal.aborted) {
      onAbort();
      return;
    }
    input.signal.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

function validatePublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReadToolExecutionError(
      "unsafe_url",
      false,
      "Web fetch requires an absolute public HTTPS URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port !== "" && url.port !== "443") ||
    isPrivateHostname(url.hostname) ||
    isIP(policyHostname(url.hostname)) !== 0
  ) {
    throw new ReadToolExecutionError(
      "unsafe_url",
      false,
      "Web fetch URL must use a public hostname and default HTTPS port without credentials.",
    );
  }
  return url;
}

function isPrivateHostname(value: string): boolean {
  const hostname = policyHostname(value);
  return hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan");
}

function policyHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/u, "");
}

function isPublicAddress(value: ResolvedAddress): boolean {
  if (isIP(value.address) !== value.family) {
    return false;
  }
  if (value.family === 6) {
    return isPublicIpv6Address(value.address);
  }
  const octets = value.address.split(".").map(Number);
  const [first, second, third] = octets;
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item))) {
    return false;
  }
  return first !== undefined && second !== undefined && third !== undefined &&
    first > 0 && first < 224 && first !== 10 && first !== 127 &&
    !(first === 100 && second >= 64 && second <= 127) &&
    !(first === 169 && second === 254) &&
    !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && (
      second === 0 || second === 2 || second === 168 ||
      (second === 88 && third === 99)
    )) &&
    !(first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) &&
    !(first === 203 && second === 0 && third === 113);
}

function isPublicIpv6Address(value: string): boolean {
  const hextets = parseIpv6Hextets(value);
  if (hextets === undefined) {
    return false;
  }
  return ALLOCATED_PUBLIC_IPV6_PREFIXES.some(([prefix, bits]) =>
    hasIpv6Prefix(hextets, prefix, bits),
  ) && !isSpecialIpv6Address(hextets);
}

function parseIpv6Hextets(value: string): readonly number[] | undefined {
  // DNS returns unbracketed addresses. Deliberately reject IPv4-embedded
  // spelling too: it cannot establish that the mapped IPv4 target is public.
  if (value.includes(".")) {
    return undefined;
  }
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const head = parseIpv6Half(halves[0]!);
  const tail = parseIpv6Half(halves[1] ?? "");
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const omitted = 8 - head.length - tail.length;
  return omitted > 0
    ? [...head, ...Array<number>(omitted).fill(0), ...tail]
    : undefined;
}

function parseIpv6Half(value: string): number[] | undefined {
  if (!value) {
    return [];
  }
  const parts = value.split(":");
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))) {
    return undefined;
  }
  return parts.map((part) => Number.parseInt(part, 16));
}

function isSpecialIpv6Address(hextets: readonly number[]): boolean {
  return (
    // IETF protocol assignments, including 2001:0000::/32 Teredo.
    hasIpv6Prefix(hextets, [0x2001, 0x0000], 23) ||
    // Documentation address space.
    hasIpv6Prefix(hextets, [0x2001, 0x0db8]) ||
    // 6to4 and the AS112 special-use service.
    hasIpv6Prefix(hextets, [0x2002]) ||
    hasIpv6Prefix(hextets, [0x2620, 0x004f, 0x8000]) ||
    // Documentation space added beyond the original 2001:db8::/32 block.
    hasIpv6Prefix(hextets, [0x3fff, 0x0000], 20)
  );
}

function hasIpv6Prefix(
  address: readonly number[],
  prefix: readonly number[],
  bits = prefix.length * 16,
): boolean {
  const wholeHextets = Math.floor(bits / 16);
  const partialBits = bits % 16;
  if (prefix.length < wholeHextets + (partialBits === 0 ? 0 : 1)) {
    return false;
  }
  for (let index = 0; index < wholeHextets; index += 1) {
    if (address[index] !== prefix[index]) {
      return false;
    }
  }
  if (partialBits === 0) {
    return true;
  }
  const mask = (0xffff << (16 - partialBits)) & 0xffff;
  return (address[wholeHextets]! & mask) ===
    (prefix[wholeHextets]! & mask);
}

function boundedStatus(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 599) {
    throw new ReadToolExecutionError(
      "provider_error",
      true,
      "Web fetch provider returned an invalid HTTP status.",
    );
  }
  return value;
}

function normalizedContentType(headers: IncomingHttpHeaders): string {
  const raw = headerValue(headers, "content-type");
  return raw?.split(";", 1)[0]?.trim().toLowerCase() || "unknown";
}

function redirectLocation(
  status: number,
  headers: IncomingHttpHeaders,
  origin: URL,
): string | undefined {
  if (status < 300 || status >= 400) {
    return undefined;
  }
  const location = headerValue(headers, "location");
  if (!location) {
    return undefined;
  }
  try {
    const redirect = new URL(location, origin);
    if (
      redirect.protocol !== "https:" ||
      redirect.username ||
      redirect.password ||
      (redirect.port !== "" && redirect.port !== "443") ||
      isPrivateHostname(redirect.hostname) ||
      isIP(policyHostname(redirect.hostname)) !== 0
    ) {
      return undefined;
    }
    return redirect.toString();
  } catch {
    return undefined;
  }
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function isSupportedTextContentType(contentType: string): boolean {
  return contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    contentType === "text/plain" ||
    contentType === "text/markdown" ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "text/xml";
}

function extractPageText(
  body: string,
  contentType: string,
  maxChars: number,
): { text: string; title?: string } {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(body);
    const title = titleMatch === null
      ? undefined
      : boundedText(htmlToText(titleMatch[1]), 500);
    return {
      text: truncateText(htmlToText(body), maxChars),
      ...(title === undefined ? {} : { title }),
    };
  }
  return { text: truncateText(normalizeText(body), maxChars) };
}

function htmlToText(value: string): string {
  return normalizeText(
    decodeHtmlEntities(
      value
        .replace(/<!--[\s\S]*?-->/gu, " ")
        .replace(
          /<(script|style|noscript|template|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
          " ",
        )
        .replace(/<\/?(?:p|div|section|article|main|header|footer|h[1-6]|li|tr|br|hr)\b[^>]*>/giu, "\n")
        .replace(/<[^>]+>/gu, " "),
    ),
  );
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value
    .replace(/&#x([0-9a-f]{1,6});?/giu, (_match, raw: string) => {
      const codePoint = Number.parseInt(raw, 16);
      return safeCodePoint(codePoint);
    })
    .replace(/&#([0-9]{1,7});?/gu, (_match, raw: string) => {
      const codePoint = Number.parseInt(raw, 10);
      return safeCodePoint(codePoint);
    })
    .replace(/&([a-z]{2,8});/giu, (match, name: string) =>
      named[name.toLowerCase()] ?? match,
    );
}

function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "�";
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t \f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function truncateText(value: string, maximum: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) {
    return value;
  }
  return `${characters.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}

function boundedText(value: string | undefined, maximum: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return truncateText(value.trim(), maximum);
}
