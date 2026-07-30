# Provider routing

`model-router.ts` is the stable public entry point. Its implementation is
separated by policy boundary under `model-router/`:

- `contracts.ts` — public role, candidate, inspection, and execution types.
- `errors.ts` — typed configuration, resolution, provider-output, and routing
  failures.
- `config.ts` — strict JSON schema, provider/model references, URL validation,
  environment indirection, and file loading.
- `hardened-fetch.ts` — redirect refusal and declared/streamed response limits.
- `fallback.ts` — the single classification policy for aborts, auth,
  validation, filtering, invalid output, HTTP status, and transport failures.
- `registry.ts` — provider SDK construction, secret/header resolution, model
  lookup, role resolution, and redacted inspection.
- `router.ts` — ordered execution and fallback orchestration.

## Extension points

Endpoints, subscriptions, headers, models, and fallback order belong in the
validated JSON configuration. A new wire protocol extends the discriminated
config/contracts in `config.ts` and `contracts.ts`, then adds its SDK
construction in `registry.ts`; it requires focused tests for secret
indirection, inspection redaction, URL policy, and error classification. Do
not add a framework merely to register another endpoint using an existing
protocol.

`protocol: "openai"` means the compatible Chat Completions wire format
(`/chat/completions`), not the OpenAI Responses API. `protocol: "deepseek"`
uses the official DeepSeek adapter and defaults `thinkingMode` to `disabled`,
which keeps bounded bot/tool turns from silently spending the output budget on
reasoning. It can be explicitly enabled in provider config. A Responses adapter
should be added as a separate protocol only when a real deployment needs it.

## Security invariants

- Configuration stores environment variable names, never literal credentials.
- Remote providers require HTTPS. Plain HTTP requires an explicit opt-in and a
  loopback hostname.
- Provider base URLs reject credentials, query strings, and fragments.
- Provider requests use `redirect: "error"` so credentials and prompts cannot
  be replayed to a redirect target.
- Both declared and streamed response bodies are bounded.
- Abort remains control flow and is never converted into provider fallback.
- Inspection reports environment references and redacted values only.

Focused verification:

```sh
node --test --import tsx tests/model-router.test.ts \
  tests/ai-agent-*.test.ts tests/digest-generation.test.ts
npm run check
npm run build
```
