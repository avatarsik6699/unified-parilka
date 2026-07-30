# Storage agent contract

Область действия: `src/storage/**` и совместимый фасад `src/store.ts`.

- Один `MessageStore` — один `DatabaseSync`. Соединение, busy retry и
  `BEGIN IMMEDIATE` принадлежат только `core.ts`; domain/schema-модули не
  открывают собственные соединения.
- Не вкладывайте транзакции. Публичный orchestration-метод создаёт границу,
  helper с суффиксом `Locked` выполняется только внутри уже открытой границы.
- Сохраняйте flat public API `MessageStore`; новые публичные методы добавляйте
  в `*Api` owning-модуля. `src/store.ts` остаётся тонким compatibility barrel.
- Текущая схема задаётся в `schema/definitions.ts`, миграционный шаг — в
  `schema/migrations.ts`, порядок/version и полная валидация — в
  `schema/lifecycle.ts`. Нельзя менять schema/semantics ad-hoc из domain-файла.
- Изменение atomic state transition требует focused test на rollback,
  повторный запуск и competing/stale writer там, где возможен TOCTOU.
- Перед handoff запустите `npm run check`,
  `tests/storage-architecture.test.ts`, `tests/store-migrations.test.ts`,
  `tests/sqlite-writer.test.ts` и тесты изменённого storage domain.

Карта файлов и правила расширения: `README.md`.
