# Agent Rules Index

Корневой `AGENTS.md` остаётся коротким контрактом. Детальные правила читаются
только по релевантному trigger.

| Rule | Когда читать |
| --- | --- |
| [Documentation](documentation.md) | Создание, удаление, перенос документации либо code change, способный сделать docs устаревшими. |

Архитектурный канон живёт в `docs/`, operator procedures — в `operations/`,
а явно запрошенный долговременный goal/handoff — в `loop-develop/`.
