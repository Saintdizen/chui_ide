#!/usr/bin/env bash
#
# Проба «hot exit» в два запуска.
#
# Почему скриптом, а не одним вызовом Electron: в одном процессе окно второго раза
# не поднять — регистрация обработчиков IPC не бывает повторной. Оба запуска
# работают с одним каталогом проекта и сессий, он передаётся переменной окружения.
#
# Это диагностика, а не проверка: она печатает, что получилось, и не падает по
# коду возврата. Судить о результате — по строкам «в сессии» и «редактор после
# перезапуска»: правка должна быть и там, и там, а файл на диске — не тронут.

set -u

dir="${CHUI_PROBE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/chui-hot-exit-XXXXXX")}"
export CHUI_PROBE_DIR="$dir"

echo "[hot-exit] каталог: $dir"

CHUI_PROBE_MODE=edit ./node_modules/.bin/electron scripts/hot-exit-probe.cjs
CHUI_PROBE_MODE=check ./node_modules/.bin/electron scripts/hot-exit-probe.cjs

rm -rf "$dir"
