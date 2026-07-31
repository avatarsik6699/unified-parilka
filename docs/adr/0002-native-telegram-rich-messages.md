# ADR 0002: нативные Telegram Rich Messages для финального ответа

- Статус решения: принято
- Состояние реализации: deployed; live Telegram Desktop E2E verified
  2026-07-31
- Дата решения: 2026-07-31

## Контекст

Финальный ответ бота до goal 005 отправлялся через classic
`sendMessage(text, { entities })` с локально вычисленными
`MessageEntity`. Классические entities не выражают semantic table или
mathematical-expression entity, поэтому отклонённый goal 004 вручную
превращал Markdown-таблицы в ASCII-блоки `pre`, а LaTeX оставался сырой
строкой. Screenshot fixture подтверждал не-Rich вывод: моноширинный блок с
copy icon и литералы `$E = mc^2$`, `$$\int_a^b f(x)\,dx$$`.

Параллельно был доказан ряд регрессий hand-rolled parser:
suffix после unsafe link терялся, list items дублировались, `2 * 3 * 4`
становилось ложным italic, соседние `***...***` стилизовали промежуток,
credential URL проходил как safe, незакрытый fence считался валидным `pre`.

Bot API 10.1+ (2026-06-11) добавил Rich Messages и `sendRichMessage`:
Telegram сам рендерит headings, ordered/unordered/task lists, GFM-таблицы,
footnotes, inline `$...$`, block `$$...$$` и fenced `math`. Установленный
`grammy@1.45.1` уже предоставляет `Api.sendRichMessage` и тип
`InputRichMessage` без обновления dependency.

## Решение

Основной путь финальной доставки — нативный `sendRichMessage` с
`InputRichMessage.markdown`:

```text
model final Markdown + telemetry footer
  -> artifact/control/Unicode cleanup (без изменений)
  -> bounded Markdown AST preflight (unified + remark-parse + remark-gfm
     + remark-math): raw HTML / media / unsafe|credential URL / malformed
     fence / limit overflow -> whole-message plain mode
     safe path: исходный Markdown, кроме невидимой канонизации коротких
                разделителей GFM-таблицы до минимум трёх дефисов
  -> GuardedTelegramPublication
       rich:  { markdown, plainText }
       plain: { plainText }
  -> saveBotTurnDraft(plainText)
  -> существующий durable sending fence
  -> rich: Api.sendRichMessage(chatId,
       { markdown, skip_entity_detection: true },
       { reply_parameters }, signal)
       └─ только однозначный parser-related 400 до ACK (ровно один раз)
          -> splitTelegramText(plainText, 4096) -> Api.sendMessage последовательно
  -> validate ACK -> recordOwnSend(canonical plainText) -> sent
       timeout/network/malformed ACK/partial/post-ACK DB error -> lost_ack
```

### Почему markdown, а не blocks

Явные `InputRichBlock*` полностью исключают серверный Markdown parse, но
требуют локально реализовывать и сопровождать GFM+math parser-to-block
mapping. Это повторяет основную ошибку 004 (локальный «почти GFM» движок) и
отклоняется. Classic entities как primary отклонены: они принципиально не
выражают native table и formula.

### Security preflight

Локальный код не рендерит и не сериализует произвольный Markdown. Bounded AST preflight
(`src/bot/rich-markdown.ts`):

- разрешает только `https:` ссылки без `username`/`password` (`new URL`),
  включая autolinks, reference definitions и явные `[text](https://…)`;
- raw HTML, image/media узлы, незакрытый fence, превышение лимитов
  (32768 code points до AST parse, 500 Telegram blocks, 16 уровней
  вложенности, дополнительный лимит 2000 AST-узлов и 20 колонок таблицы)
  переводят **весь** ответ в plain mode — частичная деградация невозможна,
  `ok: true` после частичной ошибки не возвращается;
- Telegram-only `==marked==` и `||spoiler||` пока намеренно переводят весь
  ответ в literal plain mode: CommonMark/GFM AST не строит для них точную
  visible projection, поэтому rich delivery не должна обходить mention/quote
  guards;
- remark-gfm допускает в разделителе GFM-таблицы один-два дефиса, а Telegram
  рендерит таблицу только от трёх. Для AST-распознанной таблицы preflight
  безопасно расширяет только этот невидимый разделитель (например, `:--` в
  `:---`); prose и fenced code не переписываются;
- `skip_entity_detection: true` запрещает implicit URL/mention/hashtag/
  cashtag/command/phone/card entities из текста модели: разрешённые ссылки
  остаются только явными `[text](https://…)`.

### Canonical plain text

Preflight строит полный visible plain projection (AST walk): prefix/suffix,
list items и стили не теряются и не дублируются, `2 * 3 * 4` не искажается,
соседние nested styles не схлопываются. `plainText` питает mention/quote
guards, `saveBotTurnDraft`, corpus recording и classic fallback. Durable
adapter записывает canonical plain text, а не `response.text`: rich ACK
несёт `rich_message`, а не `text`.

### Failure semantics

- Однозначный parser-related Bot API 400 (`can't parse markdown|rich
  message|entities`, `invalid rich message`) **до ACK** может ровно один раз
  открыть классический plain fallback; fallback шлёт полный canonical
  plainText, lossless разбитый до 4096 UTF-16.
- Generic 400 не маскируется под parse failure.
- Timeout, `HttpError`/socket, aborted signal, malformed success, partial
  delivery и post-ACK DB failure никогда не вызывают resend и сохраняют
  существующую `lost_ack` semantics.

### Quotes и policy

Восстановлен контракт goal 002: `validateQuotes` с `evidence` и
`minQuoteCharacters` снова вызывается на canonical plain text; attributed
quote, отсутствующий в evidence своего speaker, остаётся terminal
`quote_speaker_mismatch`; unattributed quote без evidence разрешена.
`maxChunkUtf16`/`minQuoteCharacters` снова валидируются как public policy
settings.

## Следствия

- Hand-rolled GFM lexer/render/chunk (`src/bot/rich-text/`) и
  implementation-shaped `tests/rich-text.test.ts` удалены — не остаётся двух
  расходящихся Markdown engines.
- `grammy-publisher.ts` держит узкий двухоперационный порт
  (`sendRichMessage` primary, `sendMessage` plain fallback); production
  adapter использует типизированный `Api.sendRichMessage`, без raw `fetch` и
  ручных токенов.
- Добавлены прямые dependencies: `unified`, `remark-parse`, `remark-gfm`,
  `remark-math`. `mdast-util-to-string` сознательно не используется: его
  проекция склеивает элементы списков/таблиц, поэтому canonical plain text
  строится bounded AST walk.
- Prompt-контракт обновлён: headings, ordered/unordered/task lists, GFM
  tables, `$...$`/`$$...$$`/fenced `math`, styles/code/quotes и explicit
  HTTPS links; запрещены HTML, images/media и unsafe links; исправлена
  подсказка про inline code (один backtick, не три).
- После corrective review live Telegram Desktop E2E подтвердил нативную
  таблицу-сетку и inline/block formulas. Перед этим screenshot с delimiter
  `:--` показал расхождение remark-gfm и Telegram; теперь оно закрыто
  canonicalization и отдельной regression-проверкой.

## Альтернативы

- `InputRichBlock*` — отклонено (локальный parser-to-block движок).
- Classic `sendMessage + MessageEntity` как primary — отклонено (нет native
  table/formula).
- Стриминг (`sendRichMessageDraft`), Rich HTML, media attachments, collage/
  slideshow, maps и model-controlled uploads — non-goals этого решения.
