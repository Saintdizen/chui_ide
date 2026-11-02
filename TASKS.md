# Что предстоит

Только открытые задачи. Сделанное живёт в README, тестах и в истории файла
(`git log --follow -p TASKS.md`).

## LSP: остаток от сверки с metaModel 3.17

Сделано: `didSave`, `workspace/didChangeWatchedFiles`, `textDocument/formatting`,
`textDocument/prepareRename`, `declaration`/`typeDefinition`/`implementation`.
Осталось:

1. **`workspaceSymbol/resolve`.** Список символов по проекту приходит без контейнера
   (имя модуля рядом с именем символа); при тысячах результатов список нечитаем.
2. **`documentLink` / `documentLink/resolve`.** Ссылки внутри файла (импорт на файл)
   не открываются переходом — только вручную.
3. **`willSave` и сохранение файлов вне редактора.** `didSave` идёт только для
   открытых документов.
4. **Pull-диагностика** (`textDocument/diagnostic`): работаем на push-модели и так её
   и объявляем. Переход на pull — отдельная задача с кэшем и отменой запросов.
