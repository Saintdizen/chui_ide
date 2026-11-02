# Что предстоит

Только открытые задачи. Сделанное живёт в README, тестах и в истории файла
(`git log --follow -p TASKS.md`).

## LSP: остаток от сверки с metaModel 3.17

Сделано: `didSave`, `workspace/didChangeWatchedFiles`, `textDocument/formatting`,
`textDocument/prepareRename`, `declaration`/`typeDefinition`/`implementation`,
`workspaceSymbol/resolve`. Осталось:

1. **`documentLink` / `documentLink/resolve`.** Ссылки внутри файла (импорт на файл)
   не открываются переходом — только вручную.
2. **`willSave` и сохранение файлов вне редактора.** `didSave` идёт только для
   открытых документов.
3. **Pull-диагностика** (`textDocument/diagnostic`): работаем на push-модели и так её
   и объявляем. Переход на pull — отдельная задача с кэшем и отменой запросов.
