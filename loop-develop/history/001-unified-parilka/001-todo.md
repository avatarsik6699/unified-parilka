# 001 — Unified Parilka review, decomposition and production-readiness

## Goal

Объединить legacy Python bot и Telegram Parilka MCP в один поддерживаемый
TypeScript repository, физически декомпозировать крупные модули, закрыть
воспроизводимые correctness/security/operations defects и подготовить
проверяемый migration/rollback, затем автономно заменить legacy Parilka
runtime новыми user-systemd services и доказать живую работоспособность через
Telegram E2E.

## Source Research Summary

**Decision question:** какая минимальная архитектура даёт одному нишевому
Telegram-чату durable bot, заменяемых model providers, безопасный MCP и
понятную эксплуатацию без платформенного overengineering?

**Локальное состояние:** legacy bot находится в `/home/billy/par-lang-bot`,
legacy MCP — в `/home/billy/repos/telegram-parilka-mcp`. Production baseline,
failure modes и peer-code research зафиксированы в `001-evidence/`.

**Goals:**

1. Один TypeScript codebase и один schema-versioned SQLite.
2. Раздельные Bot API и MTProto process owners.
3. Durable bot turns/outbox, bounded agent/tools/providers.
4. Structured redacted journald logging и bounded retention.
5. Domain decomposition с production files обычно 150–500, ceiling 700.
6. Reproducible snapshot/import/maintenance/digest rehearsal и rollback.
7. Документация/agent workflow в стиле `nareshka-mono`, адаптированные к
   маленькой репе.

**Non-goals:** Redis/Kafka/BullMQ, отдельный vector DB, distributed services,
generic plugin framework, model-visible shell/write tools, 80+ MCP tools,
полный Go rewrite без измеренного MTProto bottleneck, изменение общего
машинного Telegram MCP на `127.0.0.1:8765`, commit или push.

**Initial status quo:** unified implementation и offline gates существовали,
но оставались operational decomposition, final data rehearsal, повторный
independent review, systemd/MCP cutover и live Telegram E2E. Все перечисленные
этапы впоследствии завершены и зафиксированы в `001-evidence/`.

**Минимальное изменение:** сохранить два процесса/один SQLite и вынести
существующие cohesive domains за тонкие facades с теми же public contracts.

**Реальная альтернатива:** полный Go rewrite или несколько сервисов с RPC.
Она добавляет новый deploy/data boundary и не закрывает измеренную текущую
failure mode.

**Рекомендация:** TypeScript + mtcute + SQLite, bounded domain modules и
fail-closed operational gates. Confidence высокая; решение изменит только
измеренный устойчивый transport backlog или неустранимая Node memory/reconnect
проблема.

## Product Shape

```text
one host
  ├── parilka-sync: one MTProto session + history + loopback MCP
  ├── parilka-bot: one Bot API poller + durable workers
  ├── one SQLite v13: messages/bot/outbox/digests/embeddings/status
  └── timer: maintenance then provider-routed digests

provider/config swap -> config validation -> process restart
failure -> structured trace with turn/update/provider/tool IDs
cutover -> latest consistent MCP snapshot + Python overlay + verified target
```

## Implementation Checklist

1. **Снять baseline двух legacy repos/runtime/data.** Боль: без чисел нельзя
   отличить улучшение от регрессии.
2. **Сравнить код peer projects и выбрать TS/Go.** Боль: решение иначе основано
   на вкусе, а не failure modes.
3. **Реализовать unified storage/bot/sync/MCP/provider topology.** Боль:
   несколько state/session owners теряют turns и затрудняют эксплуатацию.
4. **Закрыть durability/security/cancellation/logging.** Боль: silent loss,
   duplicate send и неотслеживаемые зависания.
5. **Декомпозировать production monsters.** Боль: новые функции требуют правки
   1–4k-line файлов и создают широкий regression blast radius.
6. **Исправить red-team races.** Боль: удалённый текст может остаться в vector
   cache, а provider Retry-After — остановить history sync.
7. **Декомпозировать maintenance/import и сделать их production-built.** Боль:
   timer не должен зависеть от dev-only `tsx`, а audit/outbox не должен расти
   бесконечно.
8. **Перенести docs/agent workflow из nareshka-mono.** Боль: канон, active
   evidence и operator runbook не должны смешиваться.
9. **Повторить migration/maintenance/digest rehearsal на свежих snapshots.**
   Боль: старое shadow evidence не доказывает final delta.
10. **Провести independent final review и полный gate.** Боль: первый зелёный
    проход не доказывает convergence.
11. **Выполнить controlled production cutover.** Боль: зелёный shadow-код не
    приносит пользы, пока legacy services и harness MCP target остаются
    владельцами runtime.
12. **Проверить живой Telegram E2E.** Боль: запущенный unit ещё не доказывает,
    что account → group → mention → bot → reply и trace проходят целиком.

Актуальная трассировка исходных требований ведётся в
`001-evidence/requirements-matrix.md`; `in progress` row блокирует закрытие
этого goal.

## Target Files

- `src/storage/`, `src/bot/`, `src/digest/`, `src/mcp-tools/`, `src/sync/`,
  `src/telegram/`, `src/providers/`, `src/vector/`;
- maintenance/python-import modules и production CLI entrypoints;
- `AGENTS.md`, `llms.txt`, `.agents/rules/`, `docs/`, `operations/`,
  `loop-develop/`;
- tests и architecture checks, принадлежащие изменённому slice.

**До cutover не трогать:** legacy production DB/service files и sessions.
**Всегда не трогать:** общий Telegram MCP на `127.0.0.1:8765`, remote branches,
commit/push и значения secrets. После всех pre-cutover gates разрешены
минимальный live Telegram mention/reply test и provider call самого bot
runtime; произвольные live sends/MCP write tests не разрешены.

## Verification Commands

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
npm run smoke:mcp
npm run smoke:mcp:wrapper
npm run smoke:mcp:direct
npm run smoke:mtcute-storage
systemd-analyze --user verify systemd/*.service systemd/*.timer
git diff --check
```

Data slices дополнительно проходят consistent temp snapshots, idempotent
import, schema/quick_check/count/range/content-hash comparison, maintenance
second dry-run и digest dry-run. Rehearsal не мутирует production; отдельный
controlled cutover разрешён только после этих gates и получает собственное
deployment evidence.

## Done Means

1. Все requirements matrix items имеют code/docs/test evidence.
2. Production modules соблюдают architecture ceiling либо имеют одно
   обоснованное documented исключение.
3. Embedding source commit atomic и stale deleted/edited text не searchable.
4. Optional embeddings не задерживают следующий history tick сверх bound.
5. Import/maintenance/digest rehearsal повторён на свежих consistent snapshots.
6. Full tests/build/checks/smokes/systemd/secret/audit gates зелёные.
7. Independent security/architecture/ops re-review не содержит открытого P0/P1.
8. Legacy Parilka services остановлены/disabled только после проверенного final
   target; новые units enabled/running, canonical Parilka MCP указывает на
   unified stdio proxy, общий MCP `:8765` не изменён.
9. Один явно маркированный Telegram E2E mention получает ответ бота; update,
   turn, provider/tool и publish outcome коррелируются в journal/SQLite без
   утечки content/secrets.
10. Rollback artifacts/commands проверены, старые state/session сохранены.
11. Active record получает Final Status и переносится в history.

## Final Status

**Завершено 2026-07-30: deployed and verified.**

- Legacy Python bot и отдельный Parilka MCP объединены в декомпозированный
  TypeScript repository с двумя runtime owners: `parilka-sync` для
  MTProto/history/loopback MCP и `parilka-bot` для Bot API/durable turns.
- Production target содержит 224 636 сообщений, schema v13,
  `quick_check=ok`; повторный import и повторный maintenance не дали новых
  writes/candidates.
- Новые `parilka-sync.service`, `parilka-bot.service` и
  `parilka-maintain.timer` active/enabled. Legacy Parilka units
  disabled/inactive. Общий `telegram-mcp.service` на `:8765` не изменён;
  unified Parilka MCP слушает только loopback `:8766`.
- Один авторизованный live Telegram E2E завершён: mention `230592` →
  Bot API update `636426173` → reply `230593`; update и turn terminal `sent`,
  unsafe nonterminal rows отсутствуют.
- Финальный gate: 426/426 tests; coverage 94.39% lines, 82.19% branches,
  92.58% functions; 205 production и 88 test files; secret scan 362 files;
  audit 0 vulnerabilities; все три 13-tool MCP smokes, native mtcute storage
  smoke, systemd verify, vector benchmark p95 27.52 ms и `git diff --check`
  зелёные.
- Environment-specific startup/shutdown дефекты (Node ABI, Telethon compact
  session, mtcute signal/timeout ownership) исправлены. Controlled restart
  завершает owned stages, flush логов и reconnect/sync без потери состояния.
- Production maintenance/digest oneshot также выполнен целиком: единый
  canonical state-directory lock, SQLite maintenance и bounded DeepSeek
  generation завершились `Result=success`: days 3/3 и week 1/1 generated,
  failed 0 в финальном run.
- Rollback bundle сохранён в
  `/home/billy/.telegram-parilka-mcp/rollback/20260730T171354Z`; live rollback
  намеренно не выполнялся после успешной внешней доставки.
- Открытых P0/P1 после post-cutover review нет. Остаточные P2 перечислены в
  `001-evidence/final-reviews-2026-07-30.md` и не требуют усложнения текущей
  нишевой архитектуры.
- Commit, push и remote branches не выполнялись и не менялись. Рабочее дерево
  оставлено локальным для решения пользователя о публикации.

## Copy-Ready Goal Prompt

```text
/goal 001-todo: завершить unified Parilka TypeScript repository. Обязательно
декомпозировать production files до domain modules (обычно 150–500, ceiling
700), закрыть embedding TOCTOU/bounded cadence и ops findings, перенести
nareshka-mono docs/agent workflow без generated-map overengineering, повторить
fresh snapshot rehearsal и independent red-team, затем выполнить controlled
systemd/MCP cutover и один живой Telegram mention/reply E2E. Общий MCP 8765,
commit/push и значения secrets не трогать; rollback сохранить.
```
