# Loop Development

Этот workflow используется только для явно запрошенного `/goal` или
cross-session handoff. Обычная задача остаётся в текущем agent plan.

- `current-todo/` содержит не более одного активного `NNN-todo.md`.
- `history/` содержит verified-complete либо явно retired/superseded records.
- Номер трёхзначный, не переиспользуется.

## Active TODO format

Активная запись содержит:

- **Goal** — одна формулировка результата.
- **Source Research Summary** — decision question, локальное evidence,
  goals/non-goals, status quo, минимальное изменение, реальная альтернатива,
  recommendation/confidence.
- **Product Shape** — ожидаемая runtime/operational shape.
- **Implementation Checklist** — concrete numbered slices; каждый закрывает
  названную пользовательскую боль.
- **Target Files** — paths и границы, что не трогать.
- **Verification Commands** — focused сначала, полный fail-closed gate в конце.
- **Done Means** — проверяемые критерии.
- **Copy-Ready Goal Prompt** — краткий prompt для cold handoff.

Если работа больше примерно десяти независимых пунктов, один TODO остаётся
goal-level ledger, а implementation режется на bounded milestones. Не вести
append-only research diary: сначала текущий code/runtime, затем первичные
источники, после чего фиксируется принятое решение и проверяемый остаток.

## Closing

При завершении добавьте **Final Status**: сделанное, evidence/gates, commit
только если был авторизован, остаточные ограничения и production disposition.
Затем перенесите record и его evidence в `history/`.

Если работа retired/superseded, Final Status обязан сказать это прямо и назвать
нового owner/task; зелёные частичные проверки не выдаются за completion.

Commit/push/deploy permissions всегда записываются явно. Для goal 001 commit и
push не авторизованы; локальный deploy/cutover Parilka runtime авторизован
2026-07-30 только после rehearsal, independent review и full gates, с
post-cutover Telegram E2E и rollback readiness.
