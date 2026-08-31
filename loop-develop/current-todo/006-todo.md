# 006 — VK-транспорт: закрытие функционального разрыва с Telegram

> Permissions: только фиксация backlog по явному запросу пользователя
> («зафиксировать в беклог все доработки, которые ты описал»). Ветки,
> commit, push, deploy, restart и любой live-send не авторизованы этим
> goal-record'ом — каждый пункт при реализации получает отдельную
> авторизацию, как и остальной код в этом репозитории.

## Goal

Постепенно закрыть функциональный разрыв VK-транспорта относительно
Telegram-транспорта — по одному bounded slice за раз, каждый со своей
верификацией — без внедрения нового рантайма/абстракции сверх того, что уже
есть в `src/vk/`, `src/bot/vk-update.ts`, `src/bot/runtime/vk-adapters.ts`.

## Source Research Summary

**Decision question:** какой функционал, присутствующий у Telegram-стороны
бота (и/или у платформы VK в целом), сейчас не реализован в VK-транспорте, и
в каком порядке его имеет смысл добавлять.

### Локальное evidence (обзор 2026-08-31, чтение текущего кода)

1. `src/bot/vk-update.ts:mediaPlaceholder` — входящие фото/голос/любые
   вложения превращаются в текстовую заглушку `[вложение]`, геопозиция —
   в `[геопозиция]`. Содержимое не анализируется и не транскрибируется,
   в отличие от Telegram-стороны, где для фото есть vision-путь
   (`imageAttached`/`visionAvailable` в `src/bot/prompt.ts`), а для голоса —
   `audio_transcribe` (`src/bot/agent/tool-set.ts`, локально через Flov).
2. `src/bot/runtime/vk-adapters.ts:VkBotTurnPublisher.publish` — исходящий
   `rich`-режим приходит с уже свёрстанным Telegram Rich Markdown
   (`plainText`), но VK не умеет его рендерить: пользователь в чате видит
   сырой markdown-синтаксис (`**жирный**`, заголовки `#` и т.п.) как есть.
   Комментарий в коде явно называет это принятым v1-ограничением, не багом.
3. Там же — `photo`/`voice` publication modes деградируют в подпись как
   голый текст: реальная загрузка `generate_image`-картинки или
   voice-reply в VK (multi-step `vk.upload` для фото; `docs.getWallUploadServer`-
   аналог для voice) не реализована.
4. Typing-индикатор — **уже закрыто**, не входит в backlog: `[10] Internal
   server error` на `messages.setActivity` с community-токеном (см. комментарий
   в `vk-adapters.ts` над `createVkToolProgressBotApiPort`) заменён рабочей
   заменой — редактируемым progress-сообщением, тем же механизмом, что
   `ToolProgressPublisher` у Telegram. Коммит `6f0b495`.
5. VK Long Poll (`src/vk/`) отдаёт только `message_new`/`message_edit`.
   VK Callback API дополнительно даёт: реакции на сообщения, изменение
   состава беседы (join/leave), смену названия/аватара, закреп сообщения,
   статусы прочтения (`message_read`). Ничего из этого сейчас не
   используется в промпте/памяти бота ни на одной платформе — типизированная
   пользователем как "самая последняя очередь" доработка, требующая
   отдельного HTTP-эндпоинта (webhook), а не polling-цикла, то есть
   реального изменения формы процесса `bot-agi-bot`.
6. Стикеры/GIF — отдельно не разбираются, попадают под ту же
   `mediaPlaceholder`-заглушку, что и прочие вложения; низкий приоритет,
   не отдельный пункт ниже (накрывается тем же чеклистом, что фото/вложения,
   если вообще понадобится).

### Явно исключено пользователем (не реализовывать)

- **Inline-кнопки/keyboard для VK** — human-persona approval-флоу и любые
  callback-кнопки остаются Telegram-only функцией. Не добавлять ни в каком
  будущем slice без нового явного запроса, отменяющего это решение.
- **Отправка голоса в VK** (`voice`-publication → реальный voice-message
  upload) — не реализовывать вообще, за ненадобностью.

### Recommendation/confidence

Начинать с входящего фото (пункт 1 ниже) — самый дешёвый slice: vision-путь
уже существует end-to-end для Telegram, разрыв чисто в VK-адаптере
(нормализация вложения → `imageAttached`/URL для скачивания), новых
инструментов/промпт-контрактов не требует. Callback API — намеренно
последний: единственный пункт, меняющий форму процесса (нужен HTTP-приёмник
рядом с существующим Long Poll/poller), а не просто новый адаптер.

## Product Shape

Каждый slice остаётся отдельным bounded изменением в существующих доменных
файлах VK-транспорта, проходит собственный `npm run verify`
(или focused-подмножество + финальный полный gate) и получает отдельную
авторизацию на commit/push/deploy — как и любая другая задача в этом
репозитории. Ничего из этого не выполняется параллельно как один большой
PR.

## Implementation Checklist

Пункты в порядке приоритета (кроме явно последнего пункта 5):

1. ~~Входящее фото → vision.~~ **Сделано** (коммит `e4db30c`): VK-фото
   (триггер или прямой reply) хранится как `vkPhoto` в `messages.raw_json`
   (`src/bot/vk-update.ts`), новый транспорт-параллельный
   `src/bot/media/{vk-contracts,vk-media,vk-downloader}.ts`, `findPhoto`/
   `resolveVision` в `src/bot/media-tools.ts` пробуют Telegram-парсер, затем
   VK — `ai-agent.ts` не менялся, `imageAttached`/`visionAvailable`/
   `imageDelivered` заработали для VK автоматически. Скачивание — прямой
   HTTPS GET по URL из VK CDN, без токена и без `getFile`-шага.
2. ~~Входящее голосовое → `audio_transcribe`.~~ **Сделано** (тот же slice,
   пункт 2): VK voice-сообщения (`audio_message` attachment, `link_ogg`/
   `link_mp3`) хранятся как `vkVoice` в том же `rawJson`-поле; `findAudio`/
   `transcribeAudio`/`transcribeAudioDirect` в `media-tools.ts` обобщены на
   `TelegramMediaTarget | VkAudioTarget`, переиспользуют тот же
   `VkMediaDownloader` и тот же Flov-транскрайбер без изменений (формат
   контейнера транспорт-агностичен для ffmpeg-конвертации). Плейсхолдер
   текста для голосового без подписи — `[голосовое]`.
3. ~~Исходящий rich text → VK-совместимая деградация.~~ **Сделано**: новый
   `renderVkPlainText` (`src/bot/runtime/vk-text.ts`) снимает заголовки,
   `**жирный**`/`*курсив*`/`~~зачёркнутый~~`, inline- и fenced-код, цитаты,
   горизонтальные линии, `$$...$$` и превращает `[текст](url)` в
   `текст (url)`; не полный CommonMark-парсер, а bounded strip именно тех
   конструкций, которым учит Telegram Rich Message контракт.
   `VkBotTurnPublisher.publish` (`src/bot/runtime/vk-adapters.ts`) применяет
   его ко всем режимам публикации (`rich`/`plain`/`photo`/`voice`), не
   только к `rich`, — важно, потому что `createTelegramPublication`
   транспорт-агностичен и его wide-table fallback безусловно вставляет
   `**жирный**` ordinals независимо от промпт-контракта модели.
4. **Отправка сгенерированных изображений в VK.** Реализовать
   `vk.upload`-путь для `photo`-publication в `VkBotTurnPublisher`, чтобы
   `generate_image` результат приходил в VK реальным фото-вложением, а не
   текстовой подписью. Целевой файл: `src/bot/runtime/vk-adapters.ts`.
5. **VK Callback API (последняя очередь).** Отдельное исследование заново:
   миграция с Long Poll на Callback API (или их сосуществование) ради
   реакций, событий состава/названия беседы, статусов прочтения. Единственный
   пункт, требующий нового HTTP-приёмника рядом с `bot-agi-bot`, поэтому
   заслуживает отдельного goal-record с собственным Source Research Summary,
   а не одного слайса в этом списке, когда до него дойдёт очередь.

## Target Files

- `src/vk/` — клиент, типы, live-search, history-backfill.
- `src/bot/vk-update.ts` — нормализация входящих VK-обновлений.
- `src/bot/runtime/vk-adapters.ts` — публикация ответов в VK.
- `src/bot-daemon/composition.ts`, `src/bot-daemon/production.ts` — проводка
  новых VK-портов.
- Не трогать: `src/bot/agent/tool-set.ts` inline-button/keyboard контракты
  (их нет и не должно появиться для VK), voice-upload path для VK (не
  реализуется).

## Verification Commands

```bash
npm run check
npm run check:architecture
npm run build
npm test
npm run verify
```

Плюс focused-тест на изменённый VK-файл перед полным гейтом на каждом
slice (например `npx tsx --test tests/vk-update.test.ts` и смежные VK-тесты).

## Done Means

Каждый пункт 1–4 закрыт независимо: соответствующий разрыв с Telegram
устранён, новые/обновлённые тесты зелёные, `npm run verify` проходит без
регрессий относительно baseline (тот же набор из 7 предсуществующих
нестабильных провалов, 0 новых), изменение закоммичено и задеплоено только
после отдельной авторизации пользователя. Пункт 5 (Callback API) не
закрывается в рамках этого record — он получает собственный goal-record,
когда до него дойдёт очередь.

## Copy-Ready Goal Prompt

Продолжи backlog `006-todo.md`: реализуй следующий незакрытый пункт
Implementation Checklist по порядку (пункты 1-3 уже сделаны — начни с пункта 4,
отправка сгенерированных изображений в VK, если явно не указано иное), с
собственной верификацией и явным запросом авторизации на commit/deploy. Не
реализовывай inline-кнопки/keyboard или отправку голоса для VK — это исключено
пользователем. Пункт 5 (Callback API) не начинай без отдельного нового
research-прохода.
