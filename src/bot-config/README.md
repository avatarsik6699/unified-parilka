# Bot config slice

Loads and validates `BOT_BOTS_CONFIG_PATH`: one JSON file listing every bot
this deployment runs, shared between `bot-agi-bot` and `bot-agi-sync` (ADR
0007). Neither process owns this module — both depend on it, so it lives
outside `bot-daemon/` and `human-persona-trigger/`.

- `schema.ts` — the zod discriminated union over `role: "assistant" |
  "human-persona"`, `.strict()` per variant.
- `load.ts` — `loadBotDefinitionsFromEnv` reads and parses the file, no
  role-specific post-processing.
- `assistant.ts` — `selectAssistantChats` filters `role: "assistant"`
  entries into `AssistantChatConfig[]`, resolving each `personaPromptPath`
  file. Consumed by `bot-daemon/production.ts`.
- `human-persona.ts` — `selectHumanPersona` filters the single (0 or 1)
  `role: "human-persona"` entry into a `HumanPersonaTriggerRuntimeConfig`
  plus `approvalChatId`. Consumed by `sync/daemon-runner.ts` (trigger/send)
  and `bot-daemon/production.ts` (approval poster, disjointness check).

Invariants:

- persona prose stays in its own file (`personaPromptPath`), never inlined
  as a JSON string — multi-paragraph text needs escaping a real editor
  doesn't;
- at most one `human-persona` entry is supported today; more than one is a
  config error, not a silent "use the first one" (multi-persona for that
  role is future work, not this slice);
- `loadBotDefinitionsFromEnv` throws when `BOT_BOTS_CONFIG_PATH` is unset —
  callers that treat the human-persona role as optional must check
  `env.BOT_BOTS_CONFIG_PATH` themselves before calling it, so a deployment
  with no human-persona bot configured doesn't fail `bot-agi-sync` startup.

Focused gates:

```bash
node --test --import tsx tests/bot-config-*.test.ts
```
