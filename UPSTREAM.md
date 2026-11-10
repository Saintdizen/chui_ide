# Сверка с эталонами (ноябрь 2026)

Источники скачаны curl-ом и прочитаны поштучно. Это журнал «что взято», а не копия
чужой документации: у каждой темы указано, где она живёт у нас.

## VS Code

Страницы: `docs/agents/tools`, `docs/agents/planning`, `docs/agents/memory`,
`docs/agents/subagents`, `docs/agents/optimize-usage`, `docs/editing/intellisense`,
`docs/editing/refactoring` (HTML-версии; `.md` у agents отдаёт 404).

| Тема у них | У нас | Вывод |
|---|---|---|
| Подтверждение вызова инструмента, auto-approve, allow/deny по инструменту | `src/shared/agent-grants.ts`, `src/main/ai/agent-hooks.ts`, `src/renderer/ui/chat-approvals.ts` | взято, дальше своих правил |
| Правка параметров инструмента перед запуском | — | **не взято** (см. «Долг») |
| Терминальный инструмент | `src/main/ai/agent-terminal.ts` | взято |
| Браузерные инструменты | `src/main/ai/agent-browser.ts` | взято |
| План перед правками | `src/renderer/ui/chat-plan.ts` | взято |
| Субагенты и параллельность | — | не нужны (решение человека) |
| Инструкции/память проекта | `src/main/ai/workspace-context.ts` (`INSTRUCTION_FILES`), `src/main/ai/project-memory.ts`, `src/main/ai/agent-memory.ts` | взято |
| Экономия контекста и токенов | `src/main/ai/output-budget.ts`, `spill.ts`, `savings.ts`, `src/shared/step-counts.ts` | взято, со своим замером |
| Inlay hints, quick fix, refactor | LSP-клиент (`textDocument/codeAction`, inlay hints), `src/renderer/ui/outline.ts` | взято |
| Computer use | — | не нужно: IDE, а не десктоп-агент |

## Cursor

Страницы: `agent/overview`, `agent/plan-mode`, `agent/debug-mode`, `agent/tools/{search,terminal,browser}`,
`agent/security/run-modes` (`.md`-версии из `cursor.com/llms.txt`).

| Тема у них | У нас | Вывод |
|---|---|---|
| Run modes: ярусы прав по инструментам | `src/shared/agent-grants.ts` + `ai.editGrants` + хуки | взято (наша форма — гранулярные grants на файл/папку) |
| Песочница исполнения (`permissions.json`) | `src/main/sandbox/sandbox.ts` | взято |
| Plan Mode | `src/renderer/ui/chat-plan.ts` | взято |
| Очередь сообщений | `src/renderer/ui/chat-queue.ts` | взято |
| Checkpoints/откат правок | `src/renderer/ui/chat-checkpoints.ts` | взято |
| Semantic search / grep / web | `src/main/ai/agent-search.ts`, `agent-web.ts` | взято |
| Debug Mode (гипотезы по рантайм-логам) | — | **не взято** (см. «Долг») |
| Генерация изображений | — | не нужно |

## Zed

Страницы: `zed.dev/docs/ai/tools`, `ai/agent`, `ai/overview`.

| Инструмент у них | У нас | Вывод |
|---|---|---|
| `read_file`, `edit_file` (адресация строками) | `agent-read.ts`, `agent-edit.ts` + `patch.ts`, `edits.ts` | взято; своё — `END_OF_LINE`, «адрес строками» |
| `copy_path`, `move_path`, `create_directory`, `delete_path` | `file` (action: move/copy/mkdir/delete), плюс `format`, `organizeImports` | взято |
| `list_directory`, `find_path`, `grep` | `search` (`action`), `list` | взято |
| `diagnostics` | `checks` (`action: diagnostics`) | взято |
| `fetch`, `web_search` | `web` | взято |
| `terminal` | `terminal`, `run` | взято |
| `skill` | `skill` | взято |
| `spawn_agent` (субагент) | — | не нужен (решение человека) |

## Neovim

Источник: `runtime/doc/lsp.txt`.

| Возможность | У нас | Вывод |
|---|---|---|
| documentSymbol | `lsp` (`action: symbols`), `outline.ts` | взято |
| hover / definition / references | `lsp` (`action: hover/definition/references`) | взято |
| codeAction (quick fix) | `lsp` + UI правок | взято |
| diagnostics из буфера, а не только с диска | `checks action=diagnostics` берёт курсорный текст | взято (это наше правило «якорь и правка смотрят один текст», 98a24c6) |

## JetBrains

`jetbrains.com/llms.txt` отдаёт 404 — каталог собран из справочника IDEA
(`help/idea`): структура файла, быстрые исправления, inlay hints.

| Возможность | У нас | Вывод |
|---|---|---|
| Structure view (символы файла) | `outline.ts`, блок «Символы» | взято |
| Quick fixes без контекстного меню | code actions + палитра действий | взято |

## Xcode

`developer.apple.com/documentation/xcode` — страница рендерится JS, curl отдаёт
оболочку без текста. Сверка по ней **невозможна без браузера**; отмечено как
ограничение, а не как пробел продукта.

## Долг — разобран

1. **Правка параметров инструмента перед запуском** (VS Code) — сделано.
   Карточка браузера показывает аргументы вызова как JSON и даёт поправить их до
   запуска: исправленный `url`/`ref`/`text`/`expression` уходит в действие, а не
   остаётся текстом на карточке (`confirmBrowser(action, args)`, `permitBrowser`
   возвращает аргументы исполнения). Битый JSON не уходит — карточка просит
   исправить. У команд терминала правится сам аргумент — текст команды.
2. **Debug Mode** (Cursor) — закрыто со стороны правил. Цикл «гипотеза → запуск →
   рантайм-лог как улика → вывод» теперь прописан в правилах агента
   (`src/shared/agent-prompt.ts`, подсказка с `needs: ['debug']`): инструменты
   `debug` (точка останова, стек, переменные, evaluate) и `terminal` это умели,
   но модель о них не помнила. По-прежнему нет только автоматического сбора
   рантайм-логов в рассуждение без просьбы модели — это не пробел, а граница
   «агент предлагает, человек решает».
Снято с рассмотрения (решение человека):

- **Субагенты/параллельность** — не нужны. Не берём ни сейчас, ни в долг;
  в TASKS не заносить.
