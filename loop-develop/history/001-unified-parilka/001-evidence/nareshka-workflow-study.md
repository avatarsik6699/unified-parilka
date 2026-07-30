# Goal 001 evidence: что перенесено из `nareshka-mono`

Срез локального `/home/billy/nareshka-mono` изучен read-only 2026-07-30.
Предметный frontend/Go код не копировался; анализировалась система
документации, ownership и agent handoff.

## Проверенные источники

- `/home/billy/nareshka-mono/AGENTS.md` — короткий root contract, completion
  routing, docs system и long-lived loop trigger.
- `/home/billy/nareshka-mono/llms.txt` — компактная карта без повторения всего
  architecture index.
- `/home/billy/nareshka-mono/.agents/rules/{README,documentation}.md` —
  progressive disclosure и строгие content lanes.
- `/home/billy/nareshka-mono/docs/{README,architecture}.md` и `docs/adr/` —
  durable canon отдельно от mutable evidence.
- `/home/billy/nareshka-mono/loop-develop/README.md`,
  `current-todo/{031,033}-todo.md` — goal/research/checklist/targets/gates/done
  contract.
- `/home/billy/nareshka-mono/loop-develop/history/020-monster-decomp/` —
  safe-to-risk ordering, mechanical split, hard file ceilings, per-slice
  verification и resume contract.
- `/home/billy/nareshka-mono/domains/{mcp-tools,notifications}/` —
  README как current shape, scoped AGENTS как hazards, `module.yaml` как
  machine-readable ownership в большом monorepo.
- Root scripts, `.github/workflows/ci.yml`, `tools/maps/README.md` и
  fail-closed checkers — focused-first/full-last verification и generated
  references only where drift is demonstrated.

## Перенесённые решения

| Nareshka pattern | Parilka adaptation |
| --- | --- |
| Root `AGENTS.md` — contract/router | Короткий safety, architecture ceiling, production ownership и gate routing |
| `llms.txt` | Навигация по runtime owners/docs/operations/active goal |
| `.agents/rules/` | Пока только documentation rule с read triggers |
| `docs/` durable-only | Architecture map + ADR index; audit/research/runbook вынесены |
| `loop-develop/current-todo` | Один explicit goal `001-todo.md` с cold-handoff contract |
| `loop-develop/history` | Final/retired evidence после закрытия goal |
| Domain README + scoped hazards | Короткие README рядом с storage/bot/sync/MCP/digest/vector; AGENTS только для опасных state/session границ |
| Monster decomposition | Safe coherent slices, 150–500 target, 700 hard ceiling, focused tests после slice |
| Fail-closed guards | Маленький architecture checker для file ceilings/docs lifecycle/boundaries |

## Что намеренно не копируется

- 17 `module.yaml` passports, route maps и generators: в Parilka нет
  многодоменного route/table drift, который окупил бы этот слой.
- Гигантский deploy/runtime-path checker: нужны только узкие воспроизводимые
  guards текущих boundaries.
- Frontend browser/CDP, design-system и Go verification rules: runtime Parilka
  их не содержит.
- Tracked env-vault policy Nareshka: Parilka сохраняет secrets только вне Git.
- Один commit на файл и прямой `master`: текущий пользователь не авторизовал
  commit вообще; branch policy не переносится между репозиториями.
- Append-only STATUS journal: evidence фиксируется bounded milestone summary,
  а не бесконечным логом.

## Вывод

Копируется separation of concerns для людей и агентов, а не масштаб
монорепозитория. Для Parilka достаточно одного architecture map, ADR index,
operations lane, explicit goal ledger, domain-local README и одного небольшого
machine gate. Новый documentation/process layer допустим только при
наблюдаемой проблеме navigation или drift.
