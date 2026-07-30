import type { LanguageModel } from "ai";

export const MODEL_ROLES = ["turn", "summary"] as const;
export const MAX_MODEL_CANDIDATES_PER_ROLE = 8;
export const REDACTED = "[REDACTED]" as const;

export type ModelRole = (typeof MODEL_ROLES)[number];
export type ModelRouterEnvironment = Readonly<Record<string, string | undefined>>;

export type ModelFallbackReason =
  | "abort"
  | "auth"
  | "validation"
  | "content_filter"
  | "invalid_output"
  | "rate_limit"
  | "server_error"
  | "transport"
  | "client_error"
  | "other";

export interface ModelFallbackDecision {
  fallback: boolean;
  reason: ModelFallbackReason;
}

export interface ResolvedModelCandidate {
  reference: string;
  providerId: string;
  modelId: string;
  model: LanguageModel;
  providerOptions?: {
    deepseek: {
      thinking: {
        type: "enabled" | "disabled";
      };
    };
  };
}

export interface ModelAttemptRecord {
  candidate: string;
  providerId: string;
  modelId: string;
  attempt: number;
  decision: ModelFallbackDecision;
}


export interface ModelRouterInspection {
  allowInsecureLocal: boolean;
  providers: Array<{
    id: string;
    protocol: "anthropic" | "openai" | "deepseek";
    baseUrl: string;
    thinkingMode?: "enabled" | "disabled";
    apiKey: {
      env: string;
      value: typeof REDACTED;
    };
    headers: Record<
      string,
      {
        env: string;
        value: typeof REDACTED;
      }
    >;
  }>;
  roles: Record<ModelRole, string[]>;
}

export interface ModelExecutionResult<T> {
  value: T;
  candidate: ResolvedModelCandidate;
  attempt: number;
  failures: readonly ModelAttemptRecord[];
}

export interface ModelRouterOptions {
  env?: ModelRouterEnvironment;
}
