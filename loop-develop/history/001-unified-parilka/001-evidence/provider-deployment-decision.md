# Production provider decision — 2026-07-30

Production runtime использует уже имеющийся прямой DeepSeek API key через
официальный AI SDK adapter:

- endpoint `https://api.deepseek.com`;
- model `deepseek-v4-flash`;
- `thinkingMode=disabled`;
- secret читается wrapper-ом из owned mode 0600 file и не копируется в JSON,
  env file, logs или repository.

Причины:

1. официальный DeepSeek V4 contract поддерживает Chat Completions, tools и
   явный `thinking.type=disabled`;
2. официальный V4 contract даёт 1M context. Максимальный фактически
   отрендеренный исторический день Parilka — 627 458 characters, поэтому
   production digest limit выставлен в 800 000: выше измеренного корпуса, но
   остаётся bounded и заметно ниже provider context ceiling;
3. короткий text preflight и отдельный двухшаговый tool-call preflight прошли
   на candidate attempt 1;
4. установленный Alibaba key имеет форму Token Plan. Актуальная policy Alibaba
   прямо исключает custom application backends и предупреждает о возможной
   suspension. Использовать его для Telegram bot daemon нельзя, хотя wire
   protocol технически работает.

Источники:

- DeepSeek model/API contract:
  https://api-docs.deepseek.com/quick_start/pricing/
- DeepSeek thinking/tool contract:
  https://api-docs.deepseek.com/guides/thinking_mode
- официальный AI SDK DeepSeek adapter:
  https://ai-sdk.dev/providers/ai-sdk-providers/deepseek
- Alibaba Token Plan usage policy:
  https://www.alibabacloud.com/help/en/model-studio/token-plan-overview

Router по-прежнему поддерживает config-only замену subscriptions/endpoints и
ordered candidates. Qwen/Anthropic-compatible adapter не удалён; запрещён
только этот конкретный production billing plan для backend workload.
