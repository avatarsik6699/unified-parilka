import type {
  ModelExecutionResult,
  ModelRole,
  ResolvedModelCandidate,
} from "../providers/model-router.js";
import type {
  HumanPersonaConsentBasis,
  StoredHumanPersonaStyleProfile,
  StoredMessage,
} from "../store.js";

export const HUMAN_PERSONA_STYLE_PROMPT_VERSION = "bot-agi-human-style-v1";
export const MAX_STYLE_EXAMPLE_MESSAGES = 12;

export interface StyleProfileCompileRequest {
  personaId: string;
  targetUserKey: string;
  sourceText: string;
  sourceCount: number;
  maxOutputChars: number;
  signal: AbortSignal;
}

export interface StyleProfileCompileResult {
  profileText: string;
  model: string;
  providerId: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface StyleProfileCurateRequest {
  personaId: string;
  targetUserKey: string;
  /** Candidates the model may choose from; it selects by messageId only. */
  candidates: readonly StoredMessage[];
  maxExamples: number;
  signal: AbortSignal;
}

export interface StyleProfileCurateResult {
  /**
   * message_ids the model selected. The caller must resolve these against
   * `candidates` itself and never trust example text from the model
   * directly — this is what keeps curated examples verbatim-real.
   */
  selectedMessageIds: number[];
  model: string;
  providerId: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface StyleProfilePort {
  compileProfile(
    request: StyleProfileCompileRequest,
  ): Promise<StyleProfileCompileResult>;
  curateExamples(
    request: StyleProfileCurateRequest,
  ): Promise<StyleProfileCurateResult>;
}

export interface StyleProfileModelRouter {
  executeWithFallback<T>(
    role: ModelRole,
    attempt: (
      candidate: ResolvedModelCandidate,
      attemptNumber: number,
    ) => Promise<T>,
  ): Promise<ModelExecutionResult<T>>;
}

export interface StyleProfileStore {
  getHumanPersonaStyleSourceMessages(
    chatId: string,
    targetUserKey: string,
  ): StoredMessage[];
  getHumanPersonaStyleProfile(
    personaId: string,
    targetUserKey: string,
  ): StoredHumanPersonaStyleProfile | undefined;
  upsertHumanPersonaStyleProfile(input: {
    personaId: string;
    targetUserKey: string;
    profileText: string;
    exampleMessages: string[];
    sourceHash: string | null;
    consentBasis: HumanPersonaConsentBasis;
    model: string | null;
    provider: string | null;
  }): void;
}

export type StyleProfileGenerationStatus =
  "generated" | "unchanged" | "no_source_messages" | "failed";

export interface StyleProfileGenerationReport {
  mode: "dry_run" | "applied";
  personaId: string;
  chatId: string;
  targetUserKey: string;
  status: StyleProfileGenerationStatus;
  sourceCount: number;
  sourceHash?: string;
  exampleCount?: number;
  model?: string;
  providerId?: string;
  error?: { name: string; code: string };
  startedAt: string;
  finishedAt: string;
}

export interface StyleProfileGenerationOptions {
  store: StyleProfileStore;
  personaId: string;
  chatId: string;
  targetUserKey: string;
  consentBasis: HumanPersonaConsentBasis;
  apply?: boolean;
  port?: StyleProfilePort;
  now?: () => Date;
  maxInputChars?: number;
  maxOutputChars?: number;
  itemTimeoutMs?: number;
  maxExamples?: number;
}

export type StyleProfileGenerationErrorCode =
  | "input_too_large"
  | "generation_timeout"
  | "generation_aborted"
  | "invalid_clock";

export class StyleProfileGenerationError extends Error {
  readonly name = "StyleProfileGenerationError";

  constructor(
    readonly code: StyleProfileGenerationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
