# Что предстоит

Только открытые задачи. Сделанное живёт в README, тестах и в истории файла
(`git log --follow -p TASKS.md`).

Правило: пункт попадает сюда либо с воспроизведением, либо со ссылкой на строку
кода, либо с пометкой «проверить». Выдуманных дефектов здесь быть не должно.

Метод протокола ищется по всему `src`, а не в одном транспорте: клиентская половина
живёт в `lsp-features.ts`.

## Окружение

`web` даёт 404, `fetch` на `code.visualstudio.com` — «нет связи». Документация —
через `terminal`: `curl -sSL <url>.md` (HTML — SPA, отдаёт одну шапку).

## План

Порядок работы, сверху вниз. Без теста и `check:static` пункт не закрыт; «проверить»
сначала доводится до воспроизведения — или вычёркивается.

Сверка с документацией VS Code (`.log/vscode-docs-ideas-2026-11-02.md`, 328 статей)
дала части 7–12.

Второй проход (03.11) — не по документации, а по эталонам поведения: руководства
VS Code по интерфейсу (views, sidebars, notifications, quick picks, panel,
context menus, status bar, command palette), `custom-layout`, `accessibility`,
`chat-overview`/`chat-view`, плюс шаблоны WAI-ARIA APG (treeview, tabs, dialog,
listbox). Что было скачано — в «Источниках» в конце. Оттуда — части 13–15: три
места, где «работает» и «работает как эталон» — разные вещи. Части 13–15
закрыты целиком, поэтому открытой осталась только часть 7.

## Часть 7. Агент как среда

Осталось то, что сознательно отложено: остальное из этой части уже в коде.

1. **Субагенты** (`agents/run/subagents`): вложенный прогон с отдельным контекстом
   и своим набором инструментов. `runTool` один и однопоточный. Цена — токены
   удваиваются, нужен жёсткий лимит глубины. Брать, когда упрётся: «поищи по всему
   проекту и не забивай контекст». Следом — skills (инструкция + скрипты,
   подгружаемые по надобности).

## Как это закрывается

Пункт считается закрытым, когда есть:

- **воспроизведение** — шаги, которые до правки давали неверное поведение
  (скриншот, запись, или падающий тест; для «проверить» — сначала именно он);
- **тест** — логика в `tests/`, поведение в `tests/dom/` рядом с соседями;
- **`npm run typecheck` и `npm run check:static`** без новых замечаний;
- **README** — если поведение видно человеку, абзац там, а не только в коммите.

Отдельно: идеальный интерфейс проверяется клавиатурой и диктором, а не только
мышью. Поэтому в каждой части есть пункт про `role`/`aria` и пункт про
путь без мыши — они не «на потом», а часть определения «работает».

## Источники второго прохода

Скачано 03.11 (локально, `.md`-версии страниц VS Code отдают без JS):

- `code.visualstudio.com/api/ux-guidelines/{views,sidebars,notifications,context-menus,quick-picks,editor-actions,status-bar,panel,command-palette}`
- `code.visualstudio.com/docs/configure/custom-layout`
- `code.visualstudio.com/docs/configure/accessibility/accessibility`
- `code.visualstudio.com/docs/chat/{chat-overview,inline-chat,copilot-chat-context}`
- `code.visualstudio.com/docs/agents/run/{chat-view,artifacts}`
- `code.visualstudio.com/docs/editing/{codebasics,editingevolved}`
- `code.visualstudio.com/docs/reference/default-keybindings`
- `w3.org/WAI/ARIA/apg/patterns/{treeview,tabs,dialog-modal,listbox}`
- карта документации целиком — `code.visualstudio.com/llms.txt`

Первый проход (328 статей, разбор и отброшенное) — `.log/vscode-docs-ideas-2026-11-02.md`.
