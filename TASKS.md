# Задачи по мотивам DeepSeek Harness

Список того, что из DSH (DeepSeek Harness) имеет смысл сделать в chui_iDE. Не копия их плана,
а наш разбор: что берём, где это живёт у нас и чем проверяется.

**Что прочитано** (лендинг + репозиторий + все страницы доков и внутренние ссылки из них):

1. `https://www.deepseek.com/en/harness/` — лендинг: превью, официальные плагины (Agent teams,
   Auto approval review, Scheduled tasks, Voice input, Terminal, Agent loop, Subagents),
   «Creator mode», работа с документами, Developer tools (трасса вызова).
2. `https://github.com/deepseek-ai/deepseek-harness` — MIT, «everything is a plugin» на Cordis,
   `npx @deepseek-ai/dsh web`, профили `web`/`headless`/`sdk`/`acp`, бандлы.
3. `guide/quickstart` и вся ветка Guide: `providers`, `network-proxy`, `public-deployments`,
   `python-sdk`, `github-review`, `schedule`, `mcp-memory`, `plugin-market`.
4. `develop/basic/` (+ `tool`, `config`, `publish`), `develop/framework/*`, `develop/practice/*`,
   `develop/cordis-tutorial/*`.
5. `reference/` — `tool-catalog` (полный список инструментов со схемами), `config-catalog`,
   `api-gateway`, `agent-lifecycle`, `tool-execution-pipeline`, `capability-seams`,
   `persistence-catalog`, `cookbook/*` и ~50 страниц `reference/subsystems/*` (session, scope,
   session-query, session-reference, session-title, session-projection, persistence, spill,
   session-telemetry, llm-streaming, token-meter, system-prompt, compaction, tools, shell,
   subprocess, terminal, jobs, filesystem, lsp, ptc-runtime, web, skills, workflow, subagent,
   approval, permission-presets, sandbox, plan, user-questions, commands, goal, schedule,
   web-server, web-client, client-modules, slots, client-resources, sidebar-right, conversation,
   typert, storage, workspace, settings, credentials).
6. `docs/architecture.md` и `README.md` из репозитория.

**Как читать.** `P1` — дешёво и заметно сразу, `P2` — сильные возможности, `P3` — архитектурное и
большое. Объём: `S` — до полудня, `M` — день-два, `L` — больше.

---

## 0. Что у нас уже есть — повторять не надо

| У DSH | У нас |
|---|---|
| Scheduled tasks (Automation tasks) | `shared/scheduling.ts`, `main/schedules/schedules.ts`, `ui/schedule-modal.ts` |
| Auto approval review | `shared/approval-review.ts`, `AiService.reviewCommand`, гейт в `registerIpc` |
| Subagents (`subagent`) | инструмент `task`, `runSubAgent` в `main/ai/service.ts` |
| Developer tools: трасса вызова | `shared/run-log.ts` + `ui/run-inspector.ts`, вкладки Сводка/Аргументы/Результат/Схема/Время |
| Context compaction | сжатие истории в `ui/chat.ts` + `shared` (пересказ, отметка `.thread-summary`) |
| Skills (`skill`) | `main/ai/skills.ts`, `ui` каталог, `read_skill` |
| Custom commands | `shared/commands.ts`, `main/ai/commands.ts`, меню композера |
| `ask_user_question` | инструмент `ask`, карточка `.ask-options` |
| Plan mode | режим «План», `PLAN_MODE_TOOLS` |
| Goal (`create_goal`/`update_goal`/`get_goal`) | `shared/goal.ts`, инструмент `update_goal` |
| Memory | `main/ai/project-memory.ts`, `remember`/`forget` |
| Sandbox | `main/sandbox`, настройка `ai.sandbox` |
| Jobs (`job_*`) | `run_background`/`run_output`/`run_stop`, `main/ai/jobs.ts` |
| Terminal (`terminal_*`) | `terminal_start/read/write/stop/list`, настоящий pty |
| Browser (`stagehand_*`) | свои `browser_*`, вкладка-страница, выбор элемента, масштаб |
| MCP tools | `main/mcp`, `shared/mcp.ts`, префикс `mcp__…` |
| Spill больших выводов | `toolContext.spillDir`, `main/ai/spill.ts` |
| Session reference (`@` прошлая беседа) | `shared/session-context.ts` |
| Session title по сути | `shared/chat-title` + запрос названия после ответа |
| Web search | инструмент `web_search`, `main/ai/web-search.ts`, `shared/web-search.ts` |
| Чтение страницы (`web_fetch`) | `shared/web-fetch.ts` + `main/ai/web-fetch.ts`, настройка `ai.webFetch.enabled` |
| Ключ не показывается в окне | ключи живут в main, в renderer не уезжают |

---

## P1 — дешёвое и заметное

### 1. `web_fetch` — открыть страницу и прочитать текст — **СДЕЛАНО**
У DSH один `ctx.web` с двумя операциями (search и fetch). У нас была только выдача поиска:
агенту приходилось просить человека открыть ссылку.

Сделано: `src/shared/web-fetch.ts` (проверка адреса, HTML → текст с сохранением заголовков,
списков, таблиц и блоков кода, сбор ссылок, ответ инструмента), `src/main/ai/web-fetch.ts`
(загрузка: таймаут, потолок тела 4 МБ, кодировка из заголовка, отказы словами), инструмент
`web_fetch` в `shared/tools.ts` + `agent-tools.ts`, настройка `ai.webFetch.enabled`
(по умолчанию выключена, переключатель в разделе AI). Стерегут `tests/web-fetch.test.ts`,
`tests/web-fetch-page.test.ts` и раздел 1г-2 в `npm run smoke:agent`.

### 2. `read_image` — агент смотрит картинку — **СДЕЛАНО**
DSH отдаёт модели сам файл PNG/JPEG/WebP/GIF с авто-уменьшением. У нас картинки уже уезжали
в запрос как вложения (`ChatRequest.images`), а инструмента «посмотреть файл» не было — агент
видел только текст и не мог разобрать скриншот или макет из проекта.

Сделано: `shared/read-image.ts` (правила: какие форматы отправляем, отказы словами, план уменьшения,
текст ответа), `main/ai/read-image.ts` (разбор и перекодировка движком — `nativeImage`: длинная
сторона до 1568, потолок 1.5 МБ, файл до 12 МБ), инструмент `read_image` в `shared/tools.ts` +
`agent-tools.ts`. Картинка едет модели **отдельным сообщением прогона**: в `tool`-сообщение её
положить нельзя (у OpenAI там только текст). В беседу она не сохраняется — иначе base64 висел бы
в истории каждого следующего запроса. Внутри `run_code` инструмент запрещён: оттуда отдельного
сообщения не появляется. В карточке вызова — сам кадр (`.tool-image`).
Стерегут `tests/read-image.test.ts` и раздел 20 в `npm run smoke:agent`.

### 3. Прокси из окружения
Из `guide/network-proxy`: DSH читает `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY` при старте,
loopback всегда напрямую, SOCKS не поддерживает, всё, что DSH запускает (bash, git, gh, MCP),
наследует те же переменные. У нас прокси не поддержан вообще (по `src` нет ни одного упоминания).

- **Где:** `main/ai/provider.ts` / `openai-compatible.ts` / `anthropic.ts` (у `fetch` нет прокси в Node),
  `main/ai/web-search.ts`, `main/mcp`, запуск процессов (`run-command.ts`, `terminal`).
- **Как:** либо `undici` `ProxyAgent`/`EnvHttpProxyAgent` для HTTP-вызовов из main, либо явный
  диспетчер в одном месте и проброс его во все сетевые вызовы; для дочерних процессов —
  переменные наследуются сами, значит достаточно их не вычищать.
- **Что не делаем, как и они:** SOCKS, доверие к системным настройкам ОС.
- **Проверка:** юнит на разбор переменных (loopback, `NO_PROXY` с суффиксами и портом, отказ
  `socks5://`) + проба с локальным прокси-заглушкой.

### 4. «Утвердить план» (`exit_plan_mode`)
У DSH план в режиме «План» заканчивается вызовом `exit_plan_mode`: план показывается человеку с
выбором «утвердить / продолжить планировать с замечанием». У нас режим «План» есть, но выйти из
него можно только руками — переключив режим в композере.

- **Где:** `shared/tools.ts` + `main/ai/service.ts` (там же, где `update_plan` и `update_goal`),
  карточка — `ui/chat.ts`; права — `shared/permissions.ts`.
- **Что учесть:** утверждение переключает режим в renderer по push-событию; отказ с замечанием —
  возвращается модели результатом вызова, как `ask`.
- **Проверка:** `tests/` на разбор и на переход режима + раздел в `probe:chat`.

### 5. Ресурсы MCP (`list_mcp_resources`, `read_mcp_resource`)
Мы умеем только вызывать MCP-инструменты. У DSH есть ещё каталог ресурсов сервера (шаблоны,
чтение) — это то, чем MCP-серверы отдают «документы», а не действия.

- **Где:** `main/mcp` (клиент), `shared/mcp.ts` (типы), `shared/tools.ts` + `main/ai/agent-tools.ts`.
- **Проверка:** `tests/mcp.test.ts` расширить; сервер-заглушка в пробе.

### 6. `session_search` — поиск по прошлым беседам
DSH ищет по корпусу прошлых сессий (`session_search`, `session_event_read/search/trace`) через
отдельный индекс. У нас прошлую беседу можно только приложить через `@`, зная какую.

- **Где:** `main/ai/chat-store.ts` (беседы), `shared/session-context.ts` (как отдаём модели),
  новый инструмент в `shared/tools.ts`.
- **Как:** простой поиск по файлам бесед даёт 80 % пользы; индекс (SQLite FTS) — см. P3.
- **Проверка:** юнит на поиск и на формат результата (uri `chui://chat/<uid>`, пометка
  `untrusted`, потолки в байтах — как в `renderSessionReferences`).

### 7. `present` — итоговые файлы
DSH объявляет файлы доставкой: «вот результат», и человек открывает их из ленты; в DSH это
работает особенно для docx/xlsx/pptx. У нас агент пишет файл, а человек про него узнаёт из текста.

- **Где:** `shared/tools.ts` + `agent-tools.ts`, лента — `ui/chat.ts` (строка с кнопкой «Открыть»),
  открытие — уже есть `open_file`/`openFile` в host.
- **Проверка:** `probe:chat` (в ленте есть карточка с путём и кнопкой).

### 8. «Забрать список моделей» у провайдера
Из `guide/providers`: DSH умеет `GET /models` по введённому адресу и ключу и предлагает выбрать
модели галочками; если эндпоинт не ответил — ids вбиваются руками. У нас модели перечисляются
в настройках вручную.

- **Где:** `src/main/ai/provider.ts` и `src/shared/providers.ts`, окно настроек
  (`src/renderer/ui/settings-modal.ts`), RPC `ai.*` +
  `scripts/ui-mock.js` (иначе `tests/ui-mock-contract.test.ts` покраснеет).
- **Проверка:** юнит на разбор трёх форматов ответа + проба настроек.

### 9. Креденшелы отдельно от настроек
DSH хранит ключи в `.credentials.yaml`, а в настройках — только ссылку на них; страница получает
обрезанный дескриптор, никогда сам секрет. У нас ключ лежит в `settings.json`.

- **Где:** `main/settings.ts` (чтение/запись), `registerIpc` (что уходит в renderer).
- **Зачем:** ключ в `settings.json` попадает в бэкапы и в чужие глаза; отдельный файл проще
  исключить и проще чистить.
- **Проверка:** `tests/` на миграцию (старый файл с ключом читается, ключ переезжает) и на то,
  что в renderer уходит только признак «ключ есть».

---

## P2 — сильные возможности

### 10. `run_code` (PTC) — модель пишет программу, а не десяток вызовов — **СДЕЛАНО**
Самый ценный механизм из их набора.
Сделано: `shared/run-code.ts` (правила программы, сводка вызовов, ответ инструмента, пределы),
`main/ai/run-code.ts` (отдельный процесс: обвязка в `run-code-harness.ts`, модель прав Node —
читать проект и папку запуска, писать только в папку запуска, потомки запрещены), инструмент
`run_code` в `shared/tools.ts` + `agent-tools.ts` (внутренние вызовы идут тем же `runTool`, что
и снаружи), подсказка в `AGENT_PROMPT`. При включённой песочнице инструмент не предлагается.
Стерегут `tests/run-code.test.ts`, `tests/run-code-run.test.ts` (настоящий запуск) и раздел 1г-3
в `npm run smoke:agent`. Модель вместо серии вызовов пишет один TypeScript-программу,
где инструменты — обычные функции (`await tools.read_file({...})`), и получает результат
выполнения. Десять чтений и поисков схлопываются в один оборот, а циклы и фильтрация делаются
кодом, а не моделью.

- **Где:** новая подсистема в `main/ai` (запуск в песочнице уже есть: `main/sandbox`),
  регистрация в `shared/tools.ts`, права — `shared/permissions.ts`.
- **Что учесть:** программы исполняются в песочнице с файловой политикой сессии; вывод
  «курируется» (не мегабайт); таймаут; картинки из под-вызовов прикладываются после прогона.
  В трассу прогона такое добавит «программу» отдельным блоком (`shared/run-log.ts` уже умеет
  произвольные поля вызова).
- **Проверка:** юнит на обвязку (объявленные инструменты как функции, отказ на необъявленный),
  проба: программа из трёх вызовов даёт один оборот модели.

### 11. Агент-команды: несколько подзадач разом
DSH (Experimental) держит реестр агентов и общих задач: `list_agents`, `send_message`,
`interrupt_agent`, `wait_agent`, `spawn_teammate`, `team_task_create/get/list/update`.

- **Шаг 1 (M):** `task` принимает массив подзадач и запускает их параллельно, с общим лимитом и
  сводным отчётом. Это уже даёт «команду» без реестра.
- **Шаг 2 (L):** реестр живых агентов + задачи команды + сообщения между ними; в UI — панель
  подзадач в ленте.
- **Где:** `main/ai/service.ts` (`runSubAgent`), `shared/tools.ts`, `ui/chat.ts`.
- **Проверка:** юнит на планировщик (лимит, отмена одного не валит остальные) + проба.

### 12. `workflow` — оркестрация скриптом
Агент пишет скрипт, который сам запускает подчинённых агентов и ветвит работу по результату.
Опирается на тот же PTC-движок (см. 10) — поэтому идёт после него.

- **Где:** `main/ai` (движок), `shared/tools.ts`.
- **Проверка:** юнит на разбор/валидацию скрипта, лимиты на число агентов и глубину.

### 13. `ralph` — свежий агент на раунд
Цикл «новый агент без прошлого разговора → ограниченный отчёт → следующий раунд», пока не
готово. Долгая работа не тащит за собой всю переписку. У нас есть половина кирпичей: `task`
и цель (`shared/goal.ts`).

- **Где:** `main/ai/service.ts` поверх `runSubAgent`, инструмент в `shared/tools.ts`.
- **Проверка:** юнит на предел раундов и на формат отчёта между раундами.

### 14. Расписание: интервалы и точная дата, инструменты по одному
У DSH правило расписания бывает «раз в день в местное время», «каждые N минут (минимум 1)»,
«разовая абсолютная дата» — и на каждое действие свой инструмент: `schedule_create`,
`schedule_list`, `schedule_update` (правит на месте, сохраняя id и историю), `schedule_delete`.

- **Что у нас:** правила есть (`shared/scheduling.ts`), но набор уже; из чата расписание не
  ставится вовсе — только окно «Расписание задач…».
- **Где:** `shared/scheduling.ts` (интервал), `shared/tools.ts` + `agent-tools.ts`
  (четыре инструмента), `ui/schedule-modal.ts`.
- **Проверка:** `tests/scheduling.test.ts` на новое правило; проба `probe:schedule`.

### 15. Вебхук: беседа-ревью по событию GitHub
Из `guide/github-review`: подписанный эндпоинт; когда PR переходит из черновика в «готов к
ревью», DSH создаёт беседу под рабочей папкой репозитория и запускает read-only ревью.

- **Где:** `main` (локальный HTTP-слушатель на loopback), `main/git` (площадки уже есть),
  `ui/chat.ts` (открыть беседу), настройки.
- **Что учесть:** секрет в заголовке, размер тела, только loopback + проброс извне человеком,
  запуск строго в read-only правах.
- **Проверка:** юнит на проверку подписи и на «черновик → готов» + проба с локальной отправкой.

### 16. Голосовой ввод в композер
На лендинге это официальный плагин (`Voice input`). У нас нет ничего (по `src` — ни `voice`,
ни `speech`).

- **Где:** `ui/chat-composer.ts` (значок-кнопка `.icon-btn` в `.composer-toolbar`, подсказка через
  `title` — как у остальных кнопок), запись — media API, распознавание — RPC в main
  (провайдер или локальный whisper).
- **Что учесть:** без разрешения на микрофон — внятный текст; отмена; вставка в текущую позицию.
- **Проверка:** проба `probe:chat` (кнопка есть, отказ объясняется словами), юнит на склейку
  кусков текста.

### 17. PDF и Office-файлы
DSH показывает результаты прямо в ленте: docx, xlsx, pdf, html — и держит для этого собственные
Python-библиотеки (`load_workspace_dependencies`: numpy, pandas, python-docx, python-pptx,
openpyxl, Pillow, lxml, XlsxWriter).

- **Шаг 1 (S):** PDF открывать вкладкой-страницей — движок у нас это уже умеет (встроенный
  браузер), нужен только вид файла в `ui` и запись в `docs-index`.
- **Шаг 2 (M):** предпросмотр .docx/.xlsx — либо через Python (у нас есть выбор окружения и
  `python-env`), либо своей минимальной разметкой (xlsx → таблица, docx → текст).
- **Проверка:** юнит на разбор + `probe:markdown`-подобная проба.

---

## P3 — архитектурное и большое

### 18. Индекс бесед (session-query)
DSH держит SQLite FTS по прошлым сессиям и отвечает «где мы это обсуждали», различая «текущий
контекст», «вытесненный» и «только в журнале». У нас беседы — файлы.

- **Зачем:** поиск (п. 6) без индекса хорош до первых сотен бесед; плюс `session_trace` — «что
  было в прогоне» по прошлой беседе.
- **Где:** `main/ai/chat-store.ts`, новый модуль индекса, миграция без потери старых бесед.

### 19. Телеметрия сессии
DSH умеет отдавать журнал сессии наружу (backends, редакция секретов, свои очереди). Нам это
нужно прежде всего для себя: воспроизвести «почему прогон ушёл не туда» по файлу.

- **Где:** `shared/run-log.ts` (трасса уже собирается), запись в файл сессии по настройке,
  вычистка секретов.

### 20. Пресеты инструментов на сессию
DSH собирает набор инструментов под задачу (presets: `standard`, `cordis`, `ptc`, `minimal`),
и подзадача видит не всё. У нас набор режется только режимом и правами.

- **Где:** `main/ai/service.ts` (`canRun`, `PLAN_MODE_TOOLS`), настройки, `ui/chat-composer.ts`.
- **Зачем:** меньше описаний — больше места под контекст; «минимальный» набор для вопроса.

### 21. Headless / ACP: агент без окна
DSH можно поднять профилем `headless` или `acp` и гонять из чужого кода (есть Python SDK).
У нас всё начинается с окна.

- **Где:** `src/main/index.ts` (аргументы запуска), RPC-слой (`main/ipc`) уже отделён от окна.
- **Зачем:** скрипты, CI, «прогнать задачу по расписанию без GUI».

### 22. UI-слоты и узлы ленты
Самый интересный для будущего: у DSH клиент — набор слотов (`ctx.slots.register`), а лента — из
типизированных узлов (`ConversationNodeDefinition`). Это и есть фундамент плагинов.

- **Пока отложено** (плагины решено не делать). Но если вернёмся — начинать отсюда, а не с
  «папка с плагинами».

### 23. Типизированный RPC вместо ручного контракта
У DSH мост Host↔Client генерируется из аннотаций (`@Remote`), у нас — руками: `shared/api.ts`,
`registerIpc`, `scripts/ui-mock.js`, и договор стережёт `tests/ui-mock-contract.test.ts`.
Генерация типов и мок-заглушек из одного описания убрала бы целый класс расхождений.

---

## Чего не берём

- **Cordis и «всё есть плагин»** — своя архитектура уже сложилась; переезд на чужой фреймворк
  не окупится.
- **Web UI за реверс-прокси** (`--public-url`, `--trusted-host`) — у нас настольное приложение,
  вынос интерфейса в браузер это отдельный продукт.
- **Plugin manager и рынки плагинов** — сознательно отложены.
- **`str_replace_editor`** — у нас `apply_edit`/`apply_patch`, и они лучше.
- **`pwsh` отдельным инструментом** — у нас терминал и `run_terminal`; PowerShell приедет сам,
  если понадобится, как вид оболочки.
- **`stagehand_*`** — у нас свой браузер с вкладкой, выбором элемента и масштабом.

---

## Порядок, который предлагаю

1. ~~`web_fetch` (P1.1) — сразу снимает «агент не может открыть ссылку».~~ Сделано.
2. ~~`read_image` (P1.2) — скриншоты и макеты в проекте.~~ Сделано.
3. Прокси (P1.3) — без него половина возможностей недоступна там, где есть корпоративная сеть.
4. «Утвердить план» (P1.4) и ресурсы MCP (P1.5) — мелкие, закрывают неудобства каждый день.
5. ~~`run_code` (P2.10) — самый большой выигрыш по числу оборотов с моделью.~~ Сделано.
6. Команда подзадач (P2.11, шаг 1).
7. Дальше — по вкусу: вебхук GitHub, расписание из чата, голос.

Каждый новый инструмент проходит один и тот же путь: схема в `src/shared/tools.ts` → исполнение
в `src/main/ai/agent-tools.ts` → решение о правах (`READ_ONLY_TOOLS`, `PLAN_MODE_TOOLS`,
`isDangerousCommand`) → тест → раздел в пробе. Новый RPC — ещё и в `scripts/ui-mock.js`,
иначе покраснеет `tests/ui-mock-contract.test.ts`.
