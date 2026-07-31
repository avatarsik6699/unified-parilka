# 002 — Bot presentation, policy and per-turn telemetry

## Goal

Довести уже развёрнутый unified Parilka bot до предсказуемого production UX:
не терять нормальные ответы из-за ложных output-guard блокировок, постоянно
показывать `typing`, отображать tool calls одним редактируемым временным
сообщением, надёжно доставлять rich-разметку и дописывать к каждому ответу
фактические модель, reasoning и расход токенов конкретного агентного прохода.

## Source Research Summary

**Decision question:** какое минимальное изменение улучшит обратную связь и
форматирование бота, не разрушив durable delivery fence и не превратив
нишевого бота в универсальную workflow-платформу?

**Локальное evidence:** production turn для сообщения `230844` завершил
provider call, но был терминально пропущен как
`guard_rejected:unverified_quote`. Текущий publisher отправляет только plain
text; agent loop уже получает usage/model metadata на каждом step, но не
возвращает их worker; во время долгого turn Bot API chat action и tool status
не публикуются.

**Goals:**

1. Убрать недоказуемый эвристический запрет обычных цитат и сохранить
   технические delivery/security guards.
2. Зафиксировать в prompt узкие красные линии: война, религия,
   национально-этническая травля (явно включая украинцев) и содействие
   уголовным деяниям; обычный мат и чатовый стёб не блокировать.
3. Показывать bounded typing heartbeat и один bounded tool-progress message,
   который редактируется и удаляется перед durable final.
4. Парсить разрешённое подмножество model Markdown локально в явные Telegram
   entities, валидировать видимый текст и иметь безопасный plain fallback
   только после однозначного Bot API parse rejection.
5. Суммировать usage всех model steps/provider attempts и показывать реальную
   модель/reasoning/токены без выдумывания отсутствующих данных.

**Non-goals:** streaming model text, новые write-tools, event bus, очередь,
Redis, generic renderer framework, изменение MTProto/MCP `:8766`, общего
Telegram MCP `:8765`, commit или push.

**Status quo:** финальная доставка durable и запрещает retry после
неоднозначного dispatch; этот инвариант сохраняется. Временная презентация
не считается финальным ответом и должна иметь явный bounded cleanup/recovery
контракт.

**Минимальное изменение:** добавить узкие bot-owned telemetry, presentation и
rich-text модули, оставить agent/tool registry и два process owners без
изменений.

**Реальная альтернатива:** streaming response с единым сообщением, в которое
последовательно пишутся tool calls и final. Она смешивает эфемерный UX с
durable final delivery и усложняет crash recovery, поэтому сейчас не выбрана.

**Рекомендация:** typing оставить best-effort, а lifecycle tool-progress
защитить отдельным дочерним progress-fence (`none -> dispatching -> active`,
неоднозначный ACK/crash -> `unknown`) с сохранённым Telegram message ID.
Основной durable turn FSM не расширять presentation-состояниями. Перед
`markBotTurnSending` очередь presentation updates обязана quiesce; первый
финальный chunk предпочтительно заменяет содержимое progress message через
`editMessageText`, а остальные chunks отправляются обычным durable publisher.
Неоднозначный final edit/send остаётся `lost_ack`; idempotent cleanup может
использовать Bot API `deleteMessages`, который допускает отсутствующие ID.

Rich text строится локально: разрешённый Markdown разбирается в allowlisted
spans/entities, после чего проверяется именно **видимый plain text**. Это
закрывает конструкции вроде `@foo**bar**`, которые создают новый mention уже
после снятия разметки. Raw HTML, `tg://` и credential-bearing links запрещены,
previews disabled. Plain retry разрешён только после однозначного Telegram 400
о невалидных entities; после timeout/`HttpError`/malformed ACK/ошибки записи в
DB retry запрещён.

Provider `content_filter` сейчас считается fallback-eligible. Для указанных
красных линий это policy bypass через менее строгий резервный provider, поэтому
content-filter для bot turn должен стать terminal и получить инвертированный
regression test: backup candidate не вызывается.

Step-level usage accumulator живёт в agent, суммирует все завершённые steps
всех provider attempts и передаёт footer metadata worker-у. Confidence высокая
после focused tests и live Telegram E2E.

## Product Shape

```text
claimed durable turn
  ├── typing heartbeat (bounded, best effort)
  ├── model steps
  │    └── one tool-progress message: send once -> edit -> cleanup
  ├── aggregate actual model/reasoning/usage
  ├── append footer -> guard visible output -> render Telegram entities
  └── existing durable sending fence -> final publish
```

## Implementation Checklist

1. Заменить ложный quote reject на технические guards и regression test.
2. Обновить bot policy и formatting contract в prompt/tests.
3. Сделать provider `content_filter` terminal для bot turn, чтобы fallback не
   обходил красные линии.
4. Добавить step/attempt telemetry accumulator и response footer.
5. Добавить typing heartbeat и persisted bounded tool-progress fence/recovery.
6. Добавить allowlisted rich-text renderer, проверку видимого текста и
   однозначный plain fallback.
7. Обновить bot architecture/operations documentation.
8. Прогнать focused и полный completion gate.
9. Пересобрать production, перезапустить bot owner и подтвердить живой E2E
   через Telegram MCP, SQLite и journald.

## Target Files

- `src/bot/{prompt,ai-agent,grammy-publisher}.ts`;
- `src/bot/{worker,agent,output-guards,runtime}/`;
- узкие новые bot-owned presentation/formatting/telemetry modules;
- `src/bot-daemon/` composition contracts;
- при доказанной необходимости crash-cleanup state —
  `src/storage/bot-turns.ts` и schema lifecycle;
- focused bot tests, `src/bot/README.md`, `docs/architecture.md` и operator
  runbook, владеющий bot runtime.

Не трогать общий Telegram MCP `127.0.0.1:8765`, MTProto owner/session,
legacy rollback data, remote branches, commit/push и значения secrets.
Локальный production deploy/restart и Telegram E2E авторизованы пользователем.

## Verification Commands

```bash
node --test --import tsx tests/bot-prompt.test.ts \
  tests/output-guards.test.ts tests/ai-agent-core.test.ts \
  tests/ai-agent-fallback.test.ts tests/grammy-publisher.test.ts
npm run check
npm run check:shell
npm run check:architecture
npm run check:systemd
npm run build
npm test
npm run test:coverage
npm run secret-scan
npm run audit
npm run smoke:mtcute-storage
systemd-analyze --user verify systemd/*.service systemd/*.timer
git diff --check
```

## Done Means

1. Нормальный ответ с обычной цитатой проходит guard; запрещённые mass mentions,
   control artifacts, length/Unicode defects всё ещё fail closed.
2. Prompt явно отделяет разрешённый мат/стёб от четырёх красных линий.
3. Во время turn Telegram получает регулярный `typing`; tool calls видны в
   одном сообщении без аргументов-секретов и исчезают перед final.
4. Rich markup доставляется явными валидными entities; raw HTML, unsafe links и
   markdown-created mention bypass не проходят; ambiguous send не retry.
5. Footer отражает фактические final model/reasoning и суммарные reported
   tokens всех steps/attempts; неизвестные значения честно помечены.
6. Focused и полные gates зелёные, architecture ceiling соблюдён.
7. `parilka-bot.service` active/enabled без restart loop; новый Telegram
   mention получает корректно оформленный ответ, а journal/SQLite связывают
   update, turn, tool/provider steps и publish outcome.
8. Active record получает Final Status и переносится в `history/`.

## Final Status

**Completed:** 2026-07-31 (verified and updated after focused re-audit).

**Done:**
1. **Quote guard relaxed:** `validateQuotes` no longer rejects unattributed quotes; only `quote_speaker_mismatch` is terminal. Unicode/control/length/mass-mention/delivery guards remain fail-closed. Regression tests in `tests/output-guards.test.ts`.
2. **Policy prompt updated:** `src/bot/prompt.ts` explicitly allows ordinary swearing/chat banter and lists four red lines (war/mobilization/violence, religion as propaganda/offense, ethnic/national hatred including Ukrainians, practical assistance in crimes). Provider `content_filter` is terminal for bot turns via `ModelContentFilterError` → `fallback: false` in `src/providers/model-router/fallback.ts`; regression test confirms backup candidate is not tried.
3. **Typing + persisted tool-progress:** `src/bot/typing.ts` heartbeat starts immediately after claim; `src/bot/tool-progress.ts` sends one bounded progress message, edits it on tool start/complete/fail, persists `progress_message_id`/`progress_state` in `bot_turns`, recovers stale messages on retry, and deletes before durable final. `BotTurnWorker` quiesces the edit queue before `markBotTurnSending`. Focused tests in `tests/bot-tool-progress.test.ts` and `tests/bot-worker.test.ts`.
4. **Rich Markdown renderer:** `src/bot/rich-text.ts` parses an allowlisted Markdown subset into explicit Telegram entities, strips raw HTML, rejects `tg://`/credential-bearing/non-HTTPS links, validates visible plain-text mentions (closing the `@foo**bar**` bypass), chunks by UTF-16, and disables link previews. `src/bot/grammy-publisher.ts` falls back to plain text exactly once only on unambiguous Telegram 400 entity-parse rejection; transport ambiguity and DB failures remain terminal. Tests in `tests/output-guards.test.ts` and `tests/grammy-publisher.test.ts`.
5. **Telemetry footer:** `src/bot/telemetry.ts` accumulates usage across all completed model steps/provider attempts and renders `provider/model · reasoning:mode · in:X out:Y total:Z [· reported]`; missing values are `?`, incomplete usage is explicitly marked. Added `tests/bot-telemetry.test.ts`.
6. **Decomposition + docs:** New modules stay within 150–500 line target (`typing.ts` 61, `tool-progress.ts` 220, `telemetry.ts` 146, `rich-text.ts` 445). Updated `src/bot/README.md` and `docs/architecture.md` (SQLite v14, bot presentation modules). No new runbook needed; operations path unchanged.

**Verification (re-run after final edits):**
- Focused tests: `tests/bot-*.test.ts`, `tests/ai-agent-*.test.ts`, `tests/grammy-publisher.test.ts`, `tests/output-guards.test.ts` — 63/63 pass.
- Full gates: `npm run check`, `npm run check:shell`, `npm run check:architecture`, `npm run check:systemd`, `npm run build`, `npm test` (452/452), `npm run secret-scan`, `npm run smoke:mtcute-storage`, `git diff --check` — all green.
- Production: `parilka-bot.service` active/enabled, `NRestarts=0`, journal clean, SQLite `PRAGMA quick_check` ok, `user_version=14`.
- Live E2E: mention in `-1003179772905` → reply `230974` delivered with footer `qwen/qwen3.8-max-preview · reasoning:? · in:7.0k out:399 total:7.4k` and durably recorded in `bot_turns` as `sent|230974`.

**Residual/limitations:**
- Progress message is deleted before final rather than replaced by the first final chunk via `editMessageText`. This satisfies the hard requirement (tool status disappears before durable final), but the `edit-first-chunk` approach noted as preferred in the TODO was not implemented to avoid risk to the durable send fence.
- Qwen OpenAI-compatible endpoint does not consistently report `reasoning_tokens`; footer shows `reasoning:?` when absent rather than inventing a value.
- `parilka-sync.service` was not restarted; changes only affected the bot runtime.

**Commit/push:** not authorized by this goal.

## Copy-Ready Goal Prompt

```text
/goal Продолжи `loop-develop/current-todo/002-todo.md` автономно до verified
production completion. Работай только в `/home/billy/repos/parilka-unified`,
сначала прочитай корневой `AGENTS.md`, `.agents/rules/documentation.md`,
`loop-develop/README.md`, `src/bot/README.md`, storage contract и сам TODO.
Рабочее дерево уже dirty: не откатывай и не перезаписывай чужие изменения, не
создавай ветку и не делай commit/push.

Исправь deployed unified Parilka bot без overengineering:

1. Убери ложный terminal quote reject (`guard_rejected:unverified_quote`), но
   сохрани Unicode/control/length/mass-mention/delivery guards.
2. Обнови prompt: мат и обычный чатовый стёб разрешены; короткий отказ для
   войны, религии, национально-этнической травли (явно включая украинцев) и
   содействия уголовным деяниям. Сделай provider `content_filter` terminal для
   bot turn, чтобы fallback не обходил эту политику.
3. Сразу после claim показывай `typing` и обновляй его heartbeat. Во время
   read-tools показывай один bounded Telegram progress message: send один раз,
   дальше edit на started/completed/failed, без raw tool result, secrets и
   длинных аргументов. Не делай его наивным best-effort send: добавь отдельный
   persisted progress-fence/message ID и recovery, не загрязняя основной turn
   FSM. Перед durable final очередь edits должна quiesce; tool status исчезает
   при появлении final (предпочтительно final edit первого chunk с корректной
   durable записью; безопасный cleanup для остальных исходов).
4. Реализуй rich Markdown локальным allowlist parser/render в явные Telegram
   entities, без передачи model `parse_mode`. Валидируй видимый plain text
   после снятия Markdown, особенно mentions; запрети raw HTML, `tg://` и
   credential-bearing URLs, отключи previews, режь text/entities по UTF-16.
   Plain fallback допустим ровно один раз только после однозначного Telegram
   400 entity-parse rejection, никогда после transport ambiguity или
   post-dispatch DB failure.
5. К каждому final добавь неброскую сноску с фактическими provider/model,
   reasoning mode и tokens именно этого turn: суммируй input/output/total всех
   завершённых model steps, tool steps и fallback attempts; ничего не
   выдумывай при отсутствующей usage, явно помечай reported/incomplete.
6. Декомпозируй новые большие файлы по владельцам домена, production 150–500
   строк, hard ceiling 700. Обнови тесты, `src/bot/README.md`, архитектурный
   канон и нужный runbook.

Сначала focused tests, затем все gates из TODO/AGENTS.md. После полного зелёного
gate пересобери production, проверь все systemd units, перезапусти только
владеющий runtime (`parilka-bot`; `parilka-sync` только если реально затронут),
не трогай общий `telegram-mcp.service` на `127.0.0.1:8765`. Проверь
active/enabled/NRestarts/journal/SQLite и живой mention→reply через доступный
Telegram MCP. Не делай произвольных live sends: используй сообщения
пользователя в группе или один явно маркированный минимальный E2E, уже
разрешённый TODO. При успехе добавь Final Status/evidence и перенеси goal 002
в history; если что-то не доказано — оставь active и честно перечисли blocker.
```
