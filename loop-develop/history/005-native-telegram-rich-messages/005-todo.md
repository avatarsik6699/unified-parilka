# 005 — Native Telegram Rich Messages: таблицы и LaTeX без hand-rolled renderer

> Этот goal supersede'ит отклонённый
> `history/004-rich-render-hardening/004-todo.md`.
>
> Worktree dirty и смешивает завершённый goal 003 (memory/dream/paper) с
> ошибочной реализацией 004. Не делать broad reset/restore, не откатывать
> memory/dream/paper, schema v15, telemetry или другие unrelated изменения.
> Ветки/commit/push/deploy/restart/live Telegram send не авторизованы.

## Goal

Финальный ответ Parilka публикуется основным путём через нативный Telegram
`sendRichMessage`: Telegram сам рендерит Rich Markdown headings, списки,
таблицы и inline/block LaTeX, а локальный код отвечает только за bounded
security preflight, plain fallback и неизменную durable delivery fence.
Одновременно исправить доказанные регрессии 004 без изменения memory/dream/
paper и без live-действий.

## Source Research Summary

**Decision question:** как получить именно нативную Rich Messages-вёрстку
Telegram и не повторить ошибку 004 — попытку вручную эмулировать GFM поверх
классических `MessageEntity`?

### Локальное evidence (review 2026-07-31)

1. Текущий publisher вызывает только
   `sendMessage(text, { entities })` (`src/bot/grammy-publisher.ts`).
   Классические entities умеют inline styles, `code`/`pre`, links и quote, но
   не имеют semantic table или mathematical-expression entity.
2. Реализация 004 поэтому превращает Markdown table в ASCII-текст внутри
   `pre`. На production-скриншоте видны моноширинный блок с copy icon и сырой
   LaTeX:

   ```text
   Инлайн: $E = mc^2$
   Блок:
   $$\int_a^b f(x)\, dx$$
   ```

   Это не Rich Messages.
3. Точный screenshot fixture через текущий `renderRichTelegramText` даёт один
   `pre` только для таблицы и оставляет обе формулы литералами.
4. Установлен `grammy@1.45.1`; без обновления dependency он уже предоставляет:
   - `Api.sendRichMessage(chatId, richMessage, options, signal)`;
   - `InputRichMessage.markdown|html|blocks`;
   - `skip_entity_detection`.
   Проверено в `node_modules/grammy/out/core/api.d.ts` и
   `node_modules/@grammyjs/types/rich.d.ts`.
5. Контрпримеры текущего hand-rolled parser:
   - `до [клик](tg://user?id=1) после` → `до клик` (потерян suffix);
   - unsafe link во втором list item дублирует первый item;
   - `2 * 3 * 4` теряет `*` и создаёт ложный italic;
   - `***a*** and ***b***` создаёт ложный bold на ` and `;
   - `https://user:pass@example.com` проходит как safe URL;
   - незакрытый fence принимается за valid `pre`;
   - fenced language кладётся в `TelegramEntity.url`, не в `language`.
6. В 004 удалён вызов `validateQuotes`; `OutputGuardPolicy.evidence` осталось
   в API, но игнорируется. Тест ложной атрибуции переписан с
   `quote_speaker_mismatch` на успешную отправку. Это unrelated safety
   regression относительно goal 002.
7. Focused suite (72 tests) и `npm run check` зелёные, но закрепляют неверные
   expectations: table→`pre`, ordered list→bullets, language→`url`, quote
   mismatch→allow. Поэтому зелёный gate 004 не является product evidence.
8. Ошибочный build уже был запущен в production:
   `parilka-bot.service` active, start/build timestamp
   `2026-07-31 12:08:40 MSK`. Не перезапускать его в этом goal без новой
   явной авторизации.

### Первичные внешние источники

- Bot API 10.1 (2026-06-11) добавил Rich Messages и `sendRichMessage`.
- Bot API 10.2 (2026-07-14) добавил явные outgoing rich blocks.
- Официальный Rich Markdown поддерживает semantic headings, ordered/unordered/
  task lists, tables, footnotes, inline `$...$`, block `$$...$$` и
  fenced `math`.
- `InputRichMessage` принимает ровно один из `markdown`, `html` или `blocks`;
  `sendRichMessage` поддерживает `reply_parameters`.
- Limits: до 32768 UTF-8 characters, 500 blocks, 16 уровней вложенности и
  20 columns.

Канонический источник:
`https://core.telegram.org/bots/api#rich-message-formatting-options` и
`https://core.telegram.org/bots/api#sendrichmessage`.

### Goals

1. Primary final-delivery path — `sendRichMessage` с безопасным
   `InputRichMessage.markdown`; не `sendMessage(...entities)`.
2. Таблицы, headings, ordered/unordered/task lists, `$...$`, `$$...$$` и
   fenced `math` передаются Telegram без локального преобразования в ASCII/
   `pre`.
3. Локальный preflight не пытается рендерить GFM. Он проверяет bounded AST,
   строит видимый plain projection для guards/storage/fallback и либо допускает
   **неизменённый** safe Markdown, либо переводит **весь** ответ в plain mode.
4. Raw HTML, media/image Markdown, `tg://`, `mailto:`, `tel:`, `javascript:`,
   `data:`, non-HTTPS и URL credentials не попадают в rich payload.
5. `skip_entity_detection: true`: model text не создаёт implicit URL/mention/
   hashtag/cashtag/command/phone/card entities. Разрешённые ссылки остаются
   только явными `[text](https://...)`.
6. Mention/control/Unicode/quote guards, durable `drafted -> sending -> sent |
   lost_ack`, acknowledged-send recording и no-resend-after-ambiguity
   сохраняются.
7. После однозначного parser-related Bot API 400 до ACK разрешён один переход
   на classic plain `sendMessage`; timeout/network/malformed ACK/partial send/
   post-ACK DB failure не ретраятся.
8. Тест по screenshot fixture доказывает native rich payload и отсутствие
   вызова classic renderer.

### Non-goals

- `sendRichMessageDraft`, streaming или `tg-thinking`;
- Rich HTML, media attachments, maps, collage/slideshow и model-controlled
  uploads/fetches;
- новый process/runtime, schema/migration или изменение MTProto/MCP;
- рефактор memory/dream/paper, provider routing или telemetry semantics;
- сохранение hand-rolled renderer как второго «почти GFM» движка;
- commit, push, deploy, restart или live E2E без отдельной авторизации.

### Status quo

Model draft вместе с telemetry footer проходит `guardFinalTelegramOutput`,
локально теряет Markdown markers, режется в classic 4096-char chunks и
отправляется через `sendMessage` с вычисленными entities. Этот путь не способен
создать native table/formula и уже доказанно портит/обрезает некоторые ответы.

### Минимальное изменение

Оставить worker FSM, store и publisher failure classification, но заменить
формат publication boundary:

- `rich-markdown` preflight/visible projection вместо renderer entities;
- один native rich primary payload;
- существующий classic `sendMessage` только как plain fallback;
- точечный grammY adapter для `sendRichMessage`;
- focused tests и владеющая bot/docs документация.

Для security/plain projection использовать поддерживаемый Markdown AST parser
вместо нового regex-parser. Рекомендуемый bounded stack:
`unified` + `remark-parse` + `remark-gfm` + `remark-math` +
`mdast-util-to-string`. Это допустимая новая библиотечная зависимость:
failure mode hand-rolled parser воспроизведена выше. Не использовать AST stack
для HTML generation и не сериализовать им rich output — Telegram получает
проверенный исходный Markdown.

### Реальная альтернатива

Явные `InputRichBlock*` полностью исключают серверный Markdown parse, но требуют
локально реализовать/сопровождать GFM+math parser-to-block mapping. Для этого
slice это повторяет основную ошибку 004 и отклоняется. Classic entities
оставить primary также отклонено: они принципиально не выражают native table и
formula.

### Recommendation / confidence

Перейти на `sendRichMessage({ markdown })` сейчас: официальный API, типы и
runtime support уже присутствуют локально. Confidence высокая для transport
решения; live client rendering остаётся production verification после
отдельной авторизации.

## Product Shape

```text
model final Markdown + telemetry footer
  -> artifact/control/Unicode cleanup
  -> bounded Markdown AST preflight
       reject/whole-message plain mode:
         raw HTML, media, unsafe/credential URL, invalid bounds
       visible plain projection:
         mention + quote guards, storage text, classic fallback
       safe path keeps original Markdown byte-for-byte
  -> GuardedTelegramPublication
       rich:  { markdown, plainText }
       plain: { plainText }
  -> saveBotTurnDraft(plainText)
  -> existing durable sending fence
  -> rich: Api.sendRichMessage(
       chatId,
       { markdown, skip_entity_detection: true },
       { reply_parameters },
       signal
     )
       └─ only definitive parser-related 400 before ACK
          -> split plainText by 4096 -> Api.sendMessage sequentially
  -> validate ACK -> record own send with canonical plainText -> sent
       timeout/network/malformed ACK/partial/post-ACK DB error -> lost_ack
```

Если safe Markdown превышает Rich Message limits или preflight bounds, не
резать синтаксис посередине table/formula/fence. Выбрать whole-message plain
mode и использовать проверенный lossless classic splitter.

## Implementation Checklist

### Milestone A — зафиксировать регрессии до изменения production path

1. Добавить review-driven tests, которые на текущем коде красные:
   - screenshot Markdown с table + inline `$E = mc^2$` + block
     `$$\int_a^b f(x)\,dx$$`;
   - suffix после unsafe link не теряется;
   - list items не дублируются;
   - credential URL не допускается;
   - `2 * 3 * 4` не искажается plain projection;
   - соседние `***...***` не стилизуют промежуток;
   - unterminated fence не становится valid rich publication;
   - attributed quote с evidence другого speaker остаётся
     `quote_speaker_mismatch`.
2. Не «чинить» тесты сменой expected на текущий ошибочный результат. Fixture
   проверяет publication payload/guard contract, а не private parser shape.

### Milestone B — bounded Rich Markdown preflight

3. Добавить узкий owner, например `src/bot/rich-markdown.ts` либо
   `src/bot/rich-markdown/{contracts,preflight}.ts`:
   - parse CommonMark/GFM/math в AST с явными input/AST depth/node/link/formula
     bounds;
   - reject/whole-message plain mode для raw HTML nodes, image/media nodes,
     malformed parse и limit overflow;
   - пройти все inline/reference links через `new URL`;
   - разрешать только `https:`, требовать пустые `username`/`password`;
   - построить полный visible text без потери prefix/suffix/paragraphs;
   - сохранить safe original Markdown неизменённым.
4. `stripRawHtml`, URL neutralization и plain fallback не должны молча удалять
   semantic text. Любая деградация применяется ко всему сообщению. Не
   возвращать `{ ok: true }` после частичной ошибки.
5. Вернуть контракт goal 002:
   - снова вызывать `validateQuotes` с `evidence` и
     `minQuoteCharacters`;
   - восстановить validation `maxChunkUtf16`/`minQuoteCharacters`, если они
     остаются public policy/fallback settings;
   - `quote_speaker_mismatch` снова terminal;
   - не менять правило: unattributed quote без evidence разрешена.
   Это точечное восстановление, не новый quote-policy redesign.

### Milestone C — native publisher без ослабления durable fence

6. Заменить entity-specific `GuardedChunk` на небольшой discriminated
   publication contract. Он должен нести canonical `plainText` и либо safe
   `markdown`, либо plain mode; model HTML/blocks/media в него не входят.
7. Расширить узкий `GrammyBotApiPort` двумя явными операциями:
   `sendRichMessage` (primary) и `sendMessage` (plain fallback). Production
   adapter использует уже установленный типизированный
   `Api.sendRichMessage`; не вызывать raw `fetch`, не передавать token вручную.
8. Primary call:
   - `rich_message: { markdown, skip_entity_detection: true }`;
   - сохранить `reply_parameters` и `allow_sending_without_reply: false`;
   - не передавать `parse_mode`, `html`, `blocks` или `media`.
9. Failure semantics:
   - parser-related definitive 400 до ACK может открыть ровно один fallback
     path;
   - fallback шлёт полный canonical `plainText`, lossless разбитый до 4096;
   - generic 400 не маскировать как parse failure;
   - после первого acknowledged fallback chunk дальнейшая ошибка остаётся
     partial/lost_ack;
   - timeout, `HttpError`, socket error, malformed success, aborted signal и
     `recordOwnSend` failure не вызывают новый send.
10. Durable adapter после rich ACK записывает canonical plain text в corpus и
    raw Telegram response тем же transaction/API owner, что сейчас. Не
    предполагать наличие `response.text`: rich response использует
    `response.rich_message`.

### Milestone D — prompt, cleanup и документация

11. Заменить ложную prompt-секцию classic renderer на точный разрешённый Rich
    Markdown contract:
    - headings `#`–`######`;
    - ordered/unordered/task lists;
    - GFM tables;
    - inline `$...$`, block `$$...$$`, fenced `math`;
    - обычные styles/code/quote/explicit HTTPS links;
    - запрет HTML, images/media и non-HTTPS links.
    Исправить ошибочную подсказку про inline code с тройными backticks.
12. После переключения primary path удалить hand-rolled lexer/render/chunk
    code и тесты, которые проверяют его private approximation. Оставить только
    необходимый plain splitter и security preflight. Не держать два расходящихся
    Markdown engines.
13. Обновить:
    - `src/bot/README.md` — native Rich Messages boundary и fallback;
    - `docs/architecture.md` — убрать radar/ложное утверждение про отсутствующую
      library support;
    - новый `docs/adr/0002-native-telegram-rich-messages.md` и ADR index —
      принятое transport решение, safety/fallback/durability rationale;
    - при необходимости `llms.txt`, только если меняется routing.
    Не менять history 002/003 и не выдавать deployment как выполненный.

### Milestone E — verification и честное закрытие

14. Сначала focused tests, затем полный gate. Не запускать Bot API polling,
    provider/model calls, MTProto session или live Telegram send; все ports
    fake/mocked.
15. По окончании записать Final Status:
    - что реально реализовано;
    - exact test/gate evidence;
    - production disposition: **not deployed, awaiting explicit authorization**;
    - commit/push: **not authorized**.
    Только после этого переместить 005 в history. Если focused/full gate не
    зелёный — оставить active.

## Target Files

- `package.json`, `package-lock.json` — только согласованный Markdown AST stack;
- новый `src/bot/rich-markdown.ts` либо bounded owner directory;
- `src/bot/output-guards/{contracts,guard}.ts`,
  `src/bot/output-guards.ts`;
- `src/bot/grammy-publisher.ts`;
- `src/bot/runtime/grammy-adapters.ts`, `src/bot/runtime.ts`;
- `src/bot/worker/{contracts,dispatch,turn-worker}.ts` — только publication
  shape/count wiring, без FSM redesign;
- `src/bot/prompt.ts`;
- focused tests:
  `tests/rich-markdown.test.ts`, `tests/output-guards.test.ts`,
  `tests/grammy-publisher.test.ts`, `tests/bot-worker.test.ts`,
  `tests/bot-prompt.test.ts`, при необходимости bot runtime adapter tests;
- `src/bot/README.md`, `docs/architecture.md`, `docs/adr/README.md`, новый ADR.

Кандидаты на удаление после passing replacement tests:

- `src/bot/rich-text.ts`;
- `src/bot/rich-text/{contracts,lexer,render,chunk,index}.ts`;
- implementation-shaped `tests/rich-text.test.ts`.

**Не трогать:** memory/dream/paper goal 003, schema/storage migrations v15,
digest behavior, telemetry contents, typing/tool progress, provider routing,
MTProto, MCP `:8766`, общий Telegram MCP `:8765`, systemd units, secrets,
remote branches и unrelated dirty files.

## Verification Commands

Focused:

```bash
node --test --import tsx \
  tests/rich-markdown.test.ts \
  tests/output-guards.test.ts \
  tests/grammy-publisher.test.ts \
  tests/bot-worker.test.ts \
  tests/bot-prompt.test.ts
```

Full fail-closed gate:

```bash
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

Dependency slice дополнительно проверяет exact direct dependencies,
`npm audit`, lockfile diff и отсутствие второго production Markdown renderer.
Schema не меняется, поэтому migration rehearsal не нужен.

Запрещено в этом goal без новой команды пользователя:

```text
systemctl --user restart ...
Bot API getUpdates/sendMessage/sendRichMessage
MTProto connect/poll
provider/model calls
commit / push / deploy
```

## Done Means

1. Screenshot fixture вызывает fake `sendRichMessage` ровно один раз с
   `rich_message.markdown`, содержащим исходные table, `$...$` и `$$...$$`;
   classic `sendMessage` и entity renderer не вызываются.
2. Prompt прямо просит native tables/formulas и запрещает HTML/media/unsafe
   links; inline-code синтаксис указан правильно.
3. Safe Markdown не переписывается локально. AST preflight выдаёт полный
   visible plain text; prefix/suffix/list items не теряются и не дублируются;
   multiplication и соседние nested styles не искажаются.
4. Raw HTML/media/tg/non-HTTPS/credential links не попадают в rich payload.
   `skip_entity_detection: true` зафиксирован fake-port тестом.
5. Attributed quote mismatch снова отклоняется; unattributed quote разрешён;
   Unicode/control/mention guards не регрессировали.
6. Rich parser 400 открывает только проверенный plain fallback. Любая
   delivery ambiguity по-прежнему `lost_ack` без resend; partial fallback
   учитывается корректно.
7. ACK rich message записывает canonical plain text и Telegram message ID;
   отсутствие `response.text` не ломает durable recording.
8. Hand-rolled GFM renderer больше не является production path; ложные docs и
   implementation-shaped tests удалены/заменены.
9. Focused и полный gates зелёные. Никаких polling/model/live sends не было.
10. 005 закрыт честным Final Status и перенесён в history; production остаётся
    явно `not deployed` до отдельной авторизации.

## Copy-Ready Goal Prompt

```text
/goal Выполни `loop-develop/current-todo/005-todo.md` автономно до verified
offline completion. Работай только в `/home/billy/repos/parilka-unified`.
Сначала полностью прочитай корневой `AGENTS.md`,
`.agents/rules/documentation.md`, `loop-develop/README.md`, active TODO,
`src/bot/README.md`, `src/bot/grammy-publisher.ts`,
`src/bot/output-guards/` и `src/bot/runtime/grammy-adapters.ts`.

004 отклонён: он построил classic `sendMessage + MessageEntity`, поэтому
таблица стала `pre`, а LaTeX остался сырой строкой. Нужен основной путь через
уже доступный в установленном grammY 1.45.1 `Api.sendRichMessage` с
`InputRichMessage.markdown`, чтобы Telegram нативно рендерил headings, lists,
tables, `$...$`, `$$...$$` и fenced `math`.

Сначала добавь красные regression tests из Milestone A, включая точный
screenshot fixture. Затем:
1. Сделай bounded AST preflight на поддерживаемом Markdown parser stack:
   safe исходный Markdown не переписывать; получить полный visible plain text;
   whole-message plain mode для raw HTML/media/invalid bounds; только HTTPS
   links без credentials.
2. Восстанови удалённый 004 вызов `validateQuotes` и его policy validation:
   attributed mismatch terminal, unattributed quote allowed.
3. Замени entity chunks на узкий rich/plain publication contract.
4. Primary publisher вызывает `sendRichMessage` с
   `{ markdown, skip_entity_detection: true }` и reply_parameters.
   Однозначный parser-related 400 до ACK может один раз перейти на полный
   classic plain fallback; timeout/network/malformed ACK/partial/post-ACK DB
   failure никогда не resend.
5. Durable adapter записывает canonical plain text даже когда response содержит
   `rich_message`, а не `text`.
6. Удали hand-rolled GFM lexer/render/chunk после passing replacement tests.
7. Обнови prompt, bot README, architecture и ADR 0002.

Worktree dirty: goal 003 memory/dream/paper и schema v15 не откатывать. Не
используй broad reset/restore, не создавай/переключай ветки. Нельзя запускать
Telegram polling, MTProto, provider calls или live send; ports только fake.
Commit/push/deploy/systemd restart не авторизованы. Сначала focused tests,
потом полный gate из TODO. В Final Status честно укажи `not deployed, awaiting
explicit authorization`, затем перенеси 005 в history только при полном
зелёном offline gate.
```

---

## Final Status (2026-07-31)

**Сделано (offline, всё внутри репозитория):**

1. **Milestone A** — красные regression tests до изменения production path:
   - `tests/rich-markdown.test.ts` (новый): screenshot fixture с GFM-таблицей,
     inline `$E = mc^2$` и block `$$\int_a^b f(x)\,dx$$` (byte-for-byte),
     suffix после unsafe link, list items без дублирования, credential URL,
     `2 * 3 * 4`, соседние `***...***`, unterminated fence, лимиты (code
     points / 500 blocks / depth / table columns; Telegram-only
     `==marked==`/`||spoiler||` переводятся в plain до visible guard.
   - `tests/grammy-publisher.test.ts` (переписан): fake `sendRichMessage`
     вызывается ровно один раз с `{ markdown, skip_entity_detection: true }`
     и `reply_parameters`; classic `sendMessage` не вызывается на rich пути.
   - `tests/output-guards.test.ts`: quote mismatch снова terminal
     (`quote_speaker_mismatch`), matching/em-dash quote verified = 1,
     unattributed quote allowed; rich/plain publication contract;
     восстановленная policy validation `maxChunkUtf16`/`minQuoteCharacters`.
   - `tests/bot-worker.test.ts`, `tests/bot-worker-lifecycle.test.ts`,
     `tests/bot-runtime-workers.test.ts`, `tests/bot-prompt.test.ts` —
     publication-контракт и новый formatting prompt.
2. **Milestone B** — `src/bot/rich-markdown.ts` (новый): bounded AST preflight
   на `unified` + `remark-parse` + `remark-gfm` + `remark-math`; safe
   Markdown сохраняет visible content; только разделитель AST-распознанной
   GFM-таблицы с одним-двумя дефисами канонизируется до трёх для Telegram.
   Есть полный visible plain projection и whole-message plain mode для raw
   HTML / media / unsafe|credential
   URL / malformed fence / limit overflow; до построения AST ограничивается
   source length, отдельно считается официальный лимит 500 blocks; только
   `https:` ссылки без username/password (`new URL`), включая autolinks и
   reference definitions. `==marked==`/`||spoiler||` не уходят rich, пока нет
   exact visible projection для Telegram-specific синтаксиса.
   Восстановлены `validateQuotes` + policy validation (goal 002 контракт);
   mention guard перенесён в `output-guards/mentions.ts` с прежней семантикой.
3. **Milestone C** — publication contract `GuardedTelegramPublication`
   (`rich: { markdown, plainText } | plain: { plainText }`); primary
   publisher вызывает `Api.sendRichMessage` с
   `{ markdown, skip_entity_detection: true }` и `reply_parameters` (без
   `parse_mode`, Rich HTML, blocks, media); классический `sendMessage` только
   для plain-публикаций и ровно одного parser-related 400 fallback до ACK;
   timeout/network/aborted/malformed ACK/partial/post-ACK DB failure не
   ретраятся (существующая `lost_ack` semantics сохранена). Durable adapter
   пишет canonical plain text и message ID даже при `rich_message` без
   `response.text` (новый тест в `tests/bot-runtime-workers.test.ts`).
   `BotDaemonApi` расширен на `sendRichMessage`.
4. **Milestone D** — prompt-контракт обновлён (headings, ordered/unordered/
   task lists, GFM tables, `$...$`/`$$...$$`/fenced `math`, styles/code/
   quotes, explicit HTTPS links; запрет HTML/media/unsafe links; исправлен
   inline-code синтаксис — один backtick); hand-rolled `src/bot/rich-text/`
   (lexer/render/chunk) и `tests/rich-text.test.ts` удалены; docs обновлены:
   `src/bot/README.md`, `docs/architecture.md` (Radar), `docs/adr/README.md`,
   новый `docs/adr/0002-native-telegram-rich-messages.md`.
5. **Зависимости**: добавлены только согласованные `unified@^11.0.5`,
   `remark-parse@^11.0.0`, `remark-gfm@^4.0.1`, `remark-math@^6.0.0`.
   `mdast-util-to-string` был установлен, но удалён: его проекция теряет
   разделители списков/таблиц (`* one\n* two` → `onetwo`), поэтому plain
   projection — bounded AST walk. Один Markdown engine (серверный),
   второго локального рендерера нет.

**Evidence / gates:**

```text
node --test --import tsx tests/rich-markdown.test.ts \
  tests/output-guards.test.ts tests/grammy-publisher.test.ts \
  tests/bot-worker.test.ts tests/bot-prompt.test.ts     -> 69/69 pass
npm run check            -> tsc noEmit (src + scripts) OK
npm run check:shell      -> bash -n OK
npm run check:architecture -> rerun required after final history-link repair
npm run check:systemd    -> systemd-analyze --user verify OK
npm run build            -> tsc emit OK
npm test                 -> 495/495 pass
npm run test:coverage    -> 495/495 pass
npm run secret-scan      -> OK
npm run audit            -> 0 vulnerabilities
npm run smoke:mtcute-storage -> {"ok":true,..."shutdown":"clean"}
systemd-analyze --user verify systemd/*.service systemd/*.timer -> OK
git diff --check         -> OK
```

**Post-review corrective deployment (2026-07-31):**

1. Живой screenshot выявил последний compatibility defect: remark-gfm
   принимает table delimiter :--, а Telegram отображает table только с
   минимум тремя дефисами. Preflight теперь меняет только невидимую
   delimiter-row AST-распознанной таблицы (:-- → :---); prose и fenced
   code не затрагиваются. Prompt требует канонический delimiter; добавлен
   regression test.
2. Post-review focused suite: 67/67 pass. Полный повторный gate: check,
   architecture, full tests и coverage — 500/500 pass; shell, systemd,
   secret scan, audit (0 vulnerabilities), storage smoke, diff check и
   build — зелёные.
3. По явной авторизации владельца собранный артефакт развёрнут restart-ом
   только parilka-bot.service; parilka-sync не перезапускался. Через
   Telegram MCP отправлен marked E2E request; bot принял его, опубликовал
   один ответ в rich mode без fallback и durable cache его подтвердил.
   Telegram Desktop визуально показал native table grid, inline formula и
   block formula.

**Production disposition:** deployed and live-verified. Commit/push остаются
**not authorized**.

**Остаточные ограничения:** live client rendering (пиксельная вёрстка
Rich Messages на Telegram Desktop) уже проверен. Регулярное выражение
parser-related 400
(`can't parse markdown|rich message|entities`, `invalid rich message`)
зафиксировано тестами; в этом successful live E2E такой fallback не
потребовался. Worktree goal 003 (memory/dream/paper) и schema v15
не откатывались; ветки не создавались/не переключались.
