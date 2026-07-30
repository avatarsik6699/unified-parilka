# Final independent reviews — 2026-07-30

Статус: production deployed, live E2E пройден, post-cutover/post-fix
convergence завершён. Независимые architecture, security/data и operations
review не нашли открытых P0/P1.

## Final post-fix release gate

- TypeScript source/scripts check, architecture, shell и user-systemd verify:
  green;
- build: green;
- tests: 426/426;
- coverage: 94.39% lines, 82.19% branches, 92.58% functions;
- architecture inventory: 205 production и 88 test files;
- secret scan: 362 files, green;
- `npm audit --audit-level=moderate`: 0 vulnerabilities;
- source/wrapper/direct MCP smokes: 13 tools, green;
- native mtcute storage smoke: fresh mtcute auth SQLite migration и clean
  shutdown;
- synthetic vector benchmark: p95 27.52 ms при target 250 ms,
  RSS 116.33 MiB;
- `git diff --check`: green.

До cutover отдельный gate также был зелёным: 419/419 tests, coverage
94.45%/82.12%/92.80%, secret scan 359 files и vector p95 6.1 ms. Эти числа
сохранены только как исторический baseline и не подменяют финальные метрики
выше.

## Security/data review

P0=0, P1=0. Подтверждены credentialless normal stdio proxy, output guards,
bounded agent/tool/provider paths, redacted structured logs и
provenance-aware importer. Fresh real SQLite backup rehearsal и final handoff:
224 630 + Python overlay → 224 636 messages, 0 conflicts; второй apply —
0 writes; v13 и `quick_check=ok`. Все непустые authoritative Python source
fields совпали; canonical MTProto enrichment сохранился. После live E2E
unsafe nonterminal rows отсутствуют. Финальный delta-review подтвердил
canonical DB-parent lock, `nlink=1` до read-only preflight и повторно при lock
acquisition, cross-XDG/no-env-hardlink regressions и чистый свежий `dist`.
Compact digest invocation содержит 47 journal records и одну bounded
summary-строку без prompts/source/digest text или provider error message.

## Architecture review

P0=0, P1=0. Static graph review: 197 source nodes, 627 edges, 0 cycles и
нарушений проверенных owner/dependency boundaries. Финальный architecture gate
видит 205 production и 88 test files; documented cohesive exceptions остаются
ниже hard ceiling 700. Bot, sync, MCP, storage, tools и provider boundaries
явные; generic plugin/DI/event-bus framework не добавлен. Public facade больше
не экспортирует mtcute-specific implementation helper; native smoke считает
успехом только чистый destroy.

## Operations review

P0=0, P1=0. New units active/enabled, legacy owners disabled/inactive,
maintenance timer scheduled. Unified MCP владеет loopback `:8766`, а общий
`telegram-mcp.service` продолжает работать на `:8765` без restart/replacement.
Private env, DB/auth и rollback permissions проверены; build guards принимают
final dist и игнорируют docs-only изменения. MCP sends остаются
false/dry-run true, embeddings disabled. Final restart, reconnect/tick,
journald traces, SQLite terminal state и canonical `mcp-sync --check`
подтверждены read-only. Реальный production maintenance/digest oneshot после
исправления canonical state-directory lock завершился `Result=success`:
maintenance clean, bounded DeepSeek generation успешна, оставшийся backlog
deferred. Cross-context regression подтверждает, что timer и обычный CLI не
могут одновременно взять lock одной production DB; `--summary-only` сохраняет
в journald только bounded counts, periods и безопасные failure codes.
Финальный sync PID `551875` автоматически восстановился после штатного
`FLOOD_WAIT_25` тем же процессом: следующий cadence tick successful,
`consecutiveFailures=0`, health `ok`.

## Non-blocking residual P2

- unauthenticated TCP loopback `:8766` доступен любому процессу в host network
  namespace, а не только одному Unix user. Host/Origin/session checks защищают
  protocol и DNS rebinding, но не являются auth; hard dry-run ограничивает
  write impact. MCP approval отдельно не доказывает human approval;
- architecture gate проверяет размеры/docs, но static SCC/forbidden-import
  audit пока выполняется review-командой, а не отдельным CI assertion;
- bot unit читает shared MTProto env для общего `AppConfig`, хотя MTProto
  transport не создаёт; следующий least-privilege pass может дать bot
  отдельный sanitized config slice;
- custom mtcute destroy связан с поведением mtcute 0.31; focused
  failure-order/reopen regression test остаётся полезным перед обновлением
  зависимости;
- SIGTERM во время async bootstrap/одноразового `--once` не проходит через
  полный owner-managed cleanup;
- отдельный child-process regression для порядка
  `shutdown_completed → logger flush → exit` улучшит защиту от будущих
  зависших handles;
- deployed state пока остаётся локальным dirty worktree: для публикации и
  воспроизводимого provenance нужен отдельный авторизованный commit/tag и
  manifest хешей;
- три свежих `history_jobs=running` младше 24 часов не считаются stale и не
  связаны с активной работой; bounded maintenance корректно оставляет их до
  expiry;
- mtcute/Node startup пока пишет один `localStorage ExperimentalWarning`, а
  internal cadence log может показывать `embeddings.active=true` при
  фактически disabled/configured=false. Это observability noise, не provider
  call;
- полный rollback drill после live delivery не выполнялся: bundle/permissions/
  hashes проверены, но внешняя Telegram-доставка требует ручной disposition,
  поэтому автоматический drill был бы небезопасен;
- digest backlog остаётся намеренно bounded: 250 day и 38 week candidates при
  бюджете 3/1 generation за scheduled run;
- timer ещё не имеет естественного calendar-trigger (`LAST=-`), потому что
  проверялся ручным запуском точного installed service path; сам
  sandbox/env/lock/provider path завершился `Result=success`.

Эти пункты не нарушают текущие runtime ownership/security invariants и не
оправдывают framework-level переделку работающего нишевого production
runtime.
