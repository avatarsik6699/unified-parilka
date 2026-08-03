# Исследование agentic chat systems — check-2

Срез: 2026-08-03. Метод: read-only сопоставление текущего кода Parilka с
первичными источниками официальных проектов. Внешние Telegram/model calls не
выполнялись.

## Первичные источники и применимые идеи

1. **OpenAI Agents SDK — Sessions и Results**
   - [Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
     описывает session как durable conversation history, которая добавляется к
     следующему ходу; `RunState` совместим с pause/resume для approvals.
   - [Results](https://openai.github.io/openai-agents-js/guides/results/)
     разделяет settled streaming state, active agent, history и resumable
     interruptions. Полезный принцип: runtime state и transcript должны иметь
     явный lifecycle, а не быть только логами.

2. **LangGraph — Persistence и fault tolerance**
   - [Persistence source](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)
     разделяет thread-scoped checkpointer и cross-thread store; оба нужны для
     продолжения разговора, восстановления после interruption/failure и
     долгоживущей памяти.
   - [Fault-tolerance source](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/fault-tolerance.mdx)
     отдельно требует idempotent side effects и checkpointed failure provenance.
   - [Interrupts source](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/interrupts.mdx)
     связывает resume с persisted thread id, а не с новым независимым run.

3. **Letta (formerly MemGPT)**
   - [Official repository README](https://github.com/letta-ai/letta/blob/main/README.md)
     позиционирует систему вокруг persistent memory, которая обучается и
     улучшается со временем.
   - [Memory documentation](https://docs.letta.com/concepts/memory/) — primary
     product documentation о разделении постоянно доступной памяти и
     searchable archival memory.

4. **Open WebUI**
   - [Official repository README](https://github.com/open-webui/open-webui/blob/main/README.md)
     фиксирует persistent memory между чатами, live workflow/message flow и
     queueing сообщений пока агент отвечает. Это чатовый, а не coding-harness
     пример.

## Сопоставление с Parilka

| Идея | Фактический эквивалент Parilka | Вывод |
| --- | --- | --- |
| Durable conversation/run | `bot_updates` → `bot_turns` FSM, leases, draft/sending/lost_ack и `send_outbox` в одном SQLite | Существенная correctness-часть уже реализована; повторный generic agent framework не нужен. |
| Thread-scoped state | turn/update provenance, chat ordering и serialized coordinator | Сохранять chat/turn ownership; не переносить внешний session store. |
| Long-term memory | `bot_chat_memory`, fast notes, lessons, skills; chat-scoped/source-attributed и bounded | Паттерн memory scope уже строже, чем свободная model-owned память. |
| Resumable tool/approval state | Per-step tool trace сейчас observability-only; operator MCP writes отделены от model tools, human approval намеренно не заявляется | Не добавлять self-issued approval или универсальный checkpointer без измеренной crash/resume failure mode. При следующем таком изменении нужен явный persisted attempt/event contract. |
| Queue while responding | Durable Bot API ingest и worker pump с per-chat ordering/limits | Это полезнее generic streaming UI для данного Telegram runtime. |

## Применённые решения

- Сохраняем SQLite как единственный durable boundary: он уже покрывает
  conversation queue, turn lifecycle и memory; перенос в LangGraph/Agents SDK
  добавил бы второй state model и нарушил ownership contract.
- Укрепляем agent DX отдельной канонической completion-командой `npm run verify`,
  чтобы агентам не собирать matrix из разрозненных scripts.
- Проверяем tool lifecycle отдельно от model protocol: media/read/memory
  execution должны давать одинаково пригодные trace counters и progress events.

## Не перенесено намеренно

- Generic session/checkpointer framework, Redis/queue и vector service — нет
  доказанной failure mode для одного локального Telegram-чата.
- Автоматическое извлечение и запись памяти моделью — нарушает текущий
  source-attributed allowlist gate.
- Human-in-the-loop approval surface — в текущем контракте модель не получает
  operator write tools; self-issued `approval_id` не называется человеческим
  подтверждением.
