# Rename runbook: Parilka → bot-agi

Статус: код и checked-in конфиги переименованы (env-имена, бинарники,
systemd-юниты, npm-пакет). **Боевой `.env`, systemd `EnvironmentFile` и
установленные unit-файлы на хосте оператора этим коммитом не меняются** —
это единственное, что нужно сделать вручную по этому runbook, прежде чем
деплоить обновлённый код поверх текущего production.

Не входит в это переименование (сознательно оставлено как есть на момент
этого коммита):

- Hermes-профиль `integrations/hermes/parilka-profile/` и его установленное
  имя `parilka` (`~/.hermes/profiles/parilka`, `hermes -p parilka ...`,
  `profile_name == "parilka"` guard, plugin `parilka_chat`, managed-маркеры
  `parilka-lessons`/`parilka-skill-*`/`parilka-managed`) — это была персона
  конкретного чата, не инфраструктура репозитория; впоследствии этот профиль
  и плагин целиком удалены из репозитория (снос персоны «Джони»), operator-
  каталог `~/.hermes/profiles/parilka` на хосте это не затрагивает
  автоматически.
- `env`-переменная `PARILKA_TELEGRAM_CHAT_ID` и всё, что использовало
  Hermes-плагин `parilka_chat` — отдельное пространство имён того же,
  теперь удалённого профиля.
- Путь к БД `~/.telegram-parilka-mcp/` — реальный боевой путь на диске,
  переименование каталога не выполняется автоматически (см. ниже).
- Каталог checkout `%h/repos/parilka-unified` в systemd-юнитах — тоже не
  переименован автоматически: юниты просто ссылаются на bin-файлы внутри
  того каталога, где бы он ни лежал на хосте.
- `.opencode/command/parilka-audit.md` — имя файла = имя slash-команды,
  оставлено по явному решению.

## Порядок действий

Выполняйте по порядку; на каждом шаге сервис может быть недоступен, поэтому
делайте это в окне обслуживания.

### 1. Остановить старые unit'ы

```bash
systemctl --user stop parilka-bot.service parilka-sync.service \
  parilka-maintain.timer parilka-maintain.service \
  parilka-hermes-project.service parilka-bge-m3.service
```

### 2. Переименовать env-файл и ключи внутри него

Скопируйте существующий `.env` (или `%h/.config/parilka/parilka.env`, если
используете systemd `EnvironmentFile`) в новое имя:

```bash
mkdir -p ~/.config/bot-agi
cp ~/.config/parilka/parilka.env ~/.config/bot-agi/bot-agi.env
```

Внутри нового файла переименуйте ключи один в один (**значения не
меняются**, меняются только имена переменных слева от `=`):

| Старое имя | Новое имя |
| --- | --- |
| `PARILKA_ANTHROPIC_API_KEY` | `BOT_ANTHROPIC_API_KEY` |
| `PARILKA_BOT_APPROXIMATE_MEMBER_COUNT` | `BOT_APPROXIMATE_MEMBER_COUNT` |
| `PARILKA_BOT_AUDIO_TRANSCRIBE_BEARER_TOKEN` | `BOT_AUDIO_TRANSCRIBE_BEARER_TOKEN` |
| `PARILKA_BOT_AUDIO_TRANSCRIBE_ENDPOINT` | `BOT_AUDIO_TRANSCRIBE_ENDPOINT` |
| `PARILKA_BOT_AUDIO_TRANSCRIBE_TIMEOUT_MS` | `BOT_AUDIO_TRANSCRIBE_TIMEOUT_MS` |
| `PARILKA_BOT_CHAT_ID` | `BOT_CHAT_ID` |
| `PARILKA_BOT_CHAT_TITLE` | `BOT_CHAT_TITLE` |
| `PARILKA_BOT_DB_PATH` | `BOT_DB_PATH` |
| `PARILKA_BOT_DISPLAY_NAME` | `BOT_DISPLAY_NAME` |
| `PARILKA_BOT_EXCLUSIVE_POLLER` | `BOT_EXCLUSIVE_POLLER` |
| `PARILKA_BOT_FIRECRAWL_ENDPOINT` | `BOT_FIRECRAWL_ENDPOINT` |
| `PARILKA_BOT_HISTORY_DESCRIPTION` | `BOT_HISTORY_DESCRIPTION` |
| `PARILKA_BOT_ID` | `BOT_ID` |
| `PARILKA_BOT_INITIAL_OFFSET` | `BOT_INITIAL_OFFSET` |
| `PARILKA_BOT_MEMORY_WRITE_SENDER_IDS` | `BOT_MEMORY_WRITE_SENDER_IDS` |
| `PARILKA_BOT_MODE` | `BOT_MODE` |
| `PARILKA_BOT_MODEL_CONFIG_PATH` | `BOT_MODEL_CONFIG_PATH` |
| `PARILKA_BOT_MODEL_STEP_TIMEOUT_MS` | `BOT_MODEL_STEP_TIMEOUT_MS` |
| `PARILKA_BOT_POLL_BACKOFF_INITIAL_MS` | `BOT_POLL_BACKOFF_INITIAL_MS` |
| `PARILKA_BOT_POLL_BACKOFF_MAX_MS` | `BOT_POLL_BACKOFF_MAX_MS` |
| `PARILKA_BOT_POLL_LIMIT` | `BOT_POLL_LIMIT` |
| `PARILKA_BOT_POLL_TIMEOUT_SEC` | `BOT_POLL_TIMEOUT_SEC` |
| `PARILKA_BOT_PUBLISH_TIMEOUT_MS` | `BOT_PUBLISH_TIMEOUT_MS` |
| `PARILKA_BOT_RESEARCH_GATEWAY_SOCKET` | `BOT_RESEARCH_GATEWAY_SOCKET` |
| `PARILKA_BOT_RESEARCH_GATEWAY_TIMEOUT_MS` | `BOT_RESEARCH_GATEWAY_TIMEOUT_MS` |
| `PARILKA_BOT_SEARXNG_ENDPOINT` | `BOT_SEARXNG_ENDPOINT` |
| `PARILKA_BOT_SHUTDOWN_TIMEOUT_MS` | `BOT_SHUTDOWN_TIMEOUT_MS` |
| `PARILKA_BOT_TOKEN` | `BOT_TOKEN` |
| `PARILKA_BOT_TOKEN_FILE` | `BOT_TOKEN_FILE` |
| `PARILKA_BOT_TRIGGER_COOLDOWN_MS` | `BOT_TRIGGER_COOLDOWN_MS` |
| `PARILKA_BOT_UPDATE_MAX_ATTEMPTS` | `BOT_UPDATE_MAX_ATTEMPTS` |
| `PARILKA_BOT_USERNAME` | `BOT_USERNAME` |
| `PARILKA_BOT_WEB_SEARCH_BEARER_TOKEN_ENV` | `BOT_WEB_SEARCH_BEARER_TOKEN_ENV` |
| `PARILKA_BOT_WEB_SEARCH_ENDPOINT` | `BOT_WEB_SEARCH_ENDPOINT` |
| `PARILKA_BOT_WEB_SEARCH_PROVIDER` | `BOT_WEB_SEARCH_PROVIDER` |
| `PARILKA_BOT_WORKERS` | `BOT_WORKERS` |
| `PARILKA_DEEPSEEK_API_KEY` | `BOT_DEEPSEEK_API_KEY` |
| `PARILKA_DEEPSEEK_API_KEY_FILE` | `BOT_DEEPSEEK_API_KEY_FILE` |
| `PARILKA_DIGEST_CHAT_ID` | `BOT_DIGEST_CHAT_ID` |
| `PARILKA_DIGEST_DB_PATH` | `BOT_DIGEST_DB_PATH` |
| `PARILKA_DIGEST_ITEM_TIMEOUT_MS` | `BOT_DIGEST_ITEM_TIMEOUT_MS` |
| `PARILKA_DIGEST_MAX_DAY_GENERATIONS_PER_RUN` | `BOT_DIGEST_MAX_DAY_GENERATIONS_PER_RUN` |
| `PARILKA_DIGEST_MAX_INPUT_CHARS` | `BOT_DIGEST_MAX_INPUT_CHARS` |
| `PARILKA_DIGEST_MAX_OUTPUT_CHARS` | `BOT_DIGEST_MAX_OUTPUT_CHARS` |
| `PARILKA_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN` | `BOT_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN` |
| `PARILKA_DIGEST_MODEL_CANDIDATE_TIMEOUT_MS` | `BOT_DIGEST_MODEL_CANDIDATE_TIMEOUT_MS` |
| `PARILKA_DIGEST_MODEL_CONFIG_PATH` | `BOT_DIGEST_MODEL_CONFIG_PATH` |
| `PARILKA_DIGEST_MODEL_TOTAL_TIMEOUT_MS` | `BOT_DIGEST_MODEL_TOTAL_TIMEOUT_MS` |
| `PARILKA_DREAM_EVERY_N_MESSAGES` (уже не читается) | `BOT_DREAM_EVERY_N_MESSAGES` (уже не читается) |
| `PARILKA_DREAM_MAX_MESSAGES` (уже не читается) | `BOT_DREAM_MAX_MESSAGES` (уже не читается) |
| `PARILKA_GCLOUD_PATH` | `BOT_GCLOUD_PATH` |
| `PARILKA_HERMES_PROJECTION_ENABLED` | `BOT_HERMES_PROJECTION_ENABLED` |
| `PARILKA_LOG_LEVEL` | `BOT_LOG_LEVEL` |
| `PARILKA_MCP_HTTP_URL` | `BOT_MCP_HTTP_URL` |
| `PARILKA_MEMORY_MAX_CHARS` | `BOT_MEMORY_MAX_CHARS` |
| `PARILKA_MTPROTO_EXCLUSIVE_OWNER` | `BOT_MTPROTO_EXCLUSIVE_OWNER` |
| `PARILKA_OPENAI_API_KEY` | `BOT_OPENAI_API_KEY` |
| `PARILKA_QWEN_API_KEY` / `PARILKA_QWEN_API_KEY_FILE` | `BOT_QWEN_API_KEY` / `BOT_QWEN_API_KEY_FILE` |
| `PARILKA_VERTEX_PROJECT` | `BOT_VERTEX_PROJECT` |
| `PARILKA_VERTEX_WEB_SEARCH_MAX_OUTPUT_TOKENS` | `BOT_VERTEX_WEB_SEARCH_MAX_OUTPUT_TOKENS` |
| `PARILKA_VERTEX_WEB_SEARCH_MODEL` | `BOT_VERTEX_WEB_SEARCH_MODEL` |
| `PARILKA_VERTEX_WEB_SEARCH_REGION` | `BOT_VERTEX_WEB_SEARCH_REGION` |
| `PARILKA_WEB_SEARCH_TOKEN` | `BOT_WEB_SEARCH_TOKEN` |

`PARILKA_TELEGRAM_CHAT_ID` **не переименовывается** — это переменная
Hermes-плагина `parilka_chat`, не этого приложения.

Не забудьте про `TELEGRAM_*` переменные, которые не переименовывались —
их трогать не нужно.

### 3. БД и путь к ней

`~/.telegram-parilka-mcp/` **остаётся как есть** — это реальный путь к
боевой SQLite с историей чата. Ничего перемещать не нужно: новый код по
умолчанию продолжает искать БД по этому же пути (константа в коде тоже не
переименована, сознательно — см. отчёт аудита). Если вы всё же хотите
переименовать каталог самостоятельно, задайте `TELEGRAM_DB_PATH` и
`BOT_DB_PATH` (бывший `PARILKA_BOT_DB_PATH`) на новый путь одновременно —
они обязаны совпадать, иначе процесс не стартует.

### 4. venv BGE-M3 (опционально, низкий риск)

Дефолтный путь venv для локального BGE-M3-сервиса переименован в коде:
`~/.venvs/parilka-bge-m3` → `~/.venvs/bot-agi-bge-m3`. Это не боевые данные,
venv можно просто пересоздать на новом пути:

```bash
python3 -m venv ~/.venvs/bot-agi-bge-m3
~/.venvs/bot-agi-bge-m3/bin/pip install -r services/bge-m3/requirements.txt
```

Либо явно переопределите `BOT_BGE_M3_VENV` (бывший `PARILKA_BGE_M3_VENV`) на
старый путь, если пересоздавать venv не хотите.

### 5. Установить новые systemd unit-файлы

Юниты переименованы 1:1: `parilka-bot.service` → `bot-agi-bot.service`,
`parilka-sync.service` → `bot-agi-sync.service`, `parilka-maintain.service` →
`bot-agi-maintain.service`, `parilka-maintain.timer` →
`bot-agi-maintain.timer`, `parilka-hermes-project.service` →
`bot-agi-hermes-project.service`, `parilka-bge-m3.service` →
`bot-agi-bge-m3.service`. Они уже ссылаются на новый `EnvironmentFile`
(`%h/.config/bot-agi/bot-agi.env`) и новые bin-имена.

```bash
rm ~/.config/systemd/user/parilka-*.service ~/.config/systemd/user/parilka-*.timer
install -m 0644 systemd/bot-agi-*.service systemd/bot-agi-*.timer \
  ~/.config/systemd/user/
systemctl --user daemon-reload
```

### 6. Собрать и запустить

```bash
npm run build
systemctl --user enable --now bot-agi-sync.service
systemctl --user enable --now bot-agi-bot.service
systemctl --user enable --now bot-agi-maintain.timer
```

Если на хосте всё ещё используется Hermes gateway с ранее установленным
профилем `parilka` как primary — `bot-agi-bot.service` остаётся
установленным, но выключенным как rollback path, как и раньше под старым
именем. Сам профиль/плагин `parilka` в этом репозитории больше не
поддерживается (снос персоны «Джони»).

### 7. Проверить

```bash
systemctl --user status bot-agi-sync.service bot-agi-bot.service
journalctl --user -u bot-agi-bot.service -f -o cat
./bin/telegram-bot-agi-mcp --status
```

## Rollback

Пока старые `parilka-*` unit-файлы и старый `~/.config/parilka/parilka.env`
не удалены с хоста вручную, откат — это просто `systemctl --user stop
bot-agi-*` и `systemctl --user start parilka-*` на предыдущей версии кода
(до этого коммита). Ничего в БД или в Hermes-профиле это переименование не
меняет, откат безопасен.
