---
description: Полный Qwen-heavy аудит и улучшение bot-agi с независимыми review gates
agent: orchestrator
---

Используй skill `deepwork`. Это полный аудит с последующим исправлением подтвержденных проблем, а не только отчет.

## Цель

Провести полный ревью `bot-agi`, улучшить репозиторий там, где вывод подтвержден кодом, тестами или внешним исследованием, затем независимо перепроверить результат.

## Ограничения

- Соблюдай корневой и вложенные `AGENTS.md`.
- Не запускай Telegram polling, MTProto, реальные model/provider calls, live send, deploy или rollback.
- Не создавай ветки, коммиты и PR.
- Не читай и не печатай значения секретов.
- Не внедряй speculative abstractions, новые runtime-сервисы, очереди, DI/event bus или compatibility shims без доказанной failure mode.
- Безопасность здесь означает hard software security. Не ограничивай свободу агентного цикла и модели, не добавляй цензуру, approval gates, фильтры ответов, искусственные запреты tool calls или снижение автономности.
- Не переписывай работающие части ради стиля. Каждое изменение должно закрывать подтвержденную проблему и иметь проверяемый критерий успеха.

## Фаза 1: массовый параллельный аудит

Сначала запусти одним batch ровно 12 независимых Qwen-backed read-only/background lanes: `@explorer` для пунктов 1-9 и `@librarian` для пунктов 10-12. Не объединяй области, пока каждая может дать отдельные evidence и выводы.

1. LLM-first/vibecoding readiness и документация для агентов: навигация, discoverability, `AGENTS.md`, `llms.txt`, rules/read triggers, drift, дублирование, ADR/runbooks, размер и связность модулей, экономность контекста для агентов разных вендоров.
2. Архитектура и ownership: границы доменов, зависимости, циклы, entrypoints, process boundaries, лишняя связанность и архитектурный долг.
3. Стабильность, типизация и verification: unsafe casts, потеря ошибок, некорректные состояния, async/cancellation/timeout contracts, API/type drift, пробелы в тестах, flaky/racy места и build/check/smoke покрытие.
4. Observability: structured logging, correlation, redaction, полезные tail-команды, диагностика процессов, ротация и retention без засорения диска.
5. Event processing: идемпотентность, retry/backoff, poison events, дедупликация, ordering, crash recovery и видимость зависших состояний.
6. Storage: транзакции, миграции, SQLite lifecycle, integrity checks, атомарность, восстановление и bounded growth.
7. Telegram/MCP/provider boundaries: недоверенные данные, transport/tool contracts, timeouts, cancellation и failure isolation без ограничения агентной свободы.
8. Hard security: secrets, auth/authz, SQL/command/path injection, subprocess и filesystem boundaries, permissions, network exposure, dependency/supply-chain risks, redaction и unsafe deserialization.
9. Operations/runtime: systemd, deploy/rollback artifacts, health/debug commands, temp files, logs, cleanup, resource limits и воспроизводимая офлайн-диагностика.
10. Внешний research по open-source агентным системам именно для пользовательских чатов, не coding harnesses: общая архитектура, conversation state, memory/context и process boundaries.
11. Внешний research по chat-agent event processing, observability, logging, recovery, operator/debug tooling и bounded retention.
12. Внешний research по документации и контексту для автономных chat agents, экономии токенов, предотвращению drift и применимым к этому репозиторию решениям. Для пунктов 10-12 укажи источники, сравни несколько проектов и явно отбрасывай неподходящие решения.

Каждая lane возвращает: охват, evidence с файлами/строками или URL, severity, конкретную failure mode, минимальное исправление, способ проверки и явно отмеченные false positives/неуверенность.

## Фаза 2: синтез и gate

- Дождись всех 12 результатов и согласуй их между собой.
- Удали дубли и неподтвержденные предложения.
- Составь dependency-ordered remediation plan с небольшим количеством coherent phases и явным file ownership.
- Перед изменениями передай evidence и план Luna-backed `@oracle` для независимого архитектурного, stability и hard-security review.
- Исправь план по материальным замечаниям Oracle. Не расширяй scope без evidence.

## Фаза 3: реализация

- Делегируй реализацию Kimi-backed `@fixer`.
- Параллельные fixer lanes допустимы только для непересекающихся файлов и подсистем.
- После каждой meaningful phase запускай узкие проверки и предусмотренный deepwork Oracle gate.
- Обновляй владеющую документацию в том же slice, если меняется behavior, config, state, ownership, deployment, migration или tool/provider contract.
- Внешний research внедряй только там, где есть конкретное соответствие существующей архитектуре и доказуемая польза.

## Фаза 4: проверка и финальный review

- Сначала выполни focused tests для измененных областей.
- Затем, если изменения этого требуют, выполни корневые completion gates: `npm run check`, `npm run check:shell`, `npm run check:architecture`, `npm run build`, `npm test`, `npm run secret-scan`, `npm run smoke:mtcute-storage`.
- Для MCP изменений также выполни `npm run smoke:mcp`, `npm run smoke:mcp:wrapper`, `npm run smoke:mcp:direct`.
- Для systemd изменений выполни `systemd-analyze --user verify` на затронутых units.
- Для state/migration изменений используй только temp DB: rehearsal, `PRAGMA quick_check`, schema/count/hash evidence и повторный idempotence run.
- Запусти Qwen read-only verification lanes для сопоставления результата с исходными 12 областями.
- Заверши независимым Luna-backed `@oracle` review всего diff, остаточных рисков, документационного drift и соответствия исходной цели.
- Материальные финальные findings исправь одним bounded Kimi pass и повтори только затронутые проверки.

## Результат

Финальный ответ должен содержать: что подтверждено, что исправлено, какие проверки реально прошли, какие внешние решения приняты или отвергнуты и почему, а также только реальные остаточные риски. Не заявляй полный охват без evidence от всех lanes.

Дополнительные уточнения пользователя: $ARGUMENTS
