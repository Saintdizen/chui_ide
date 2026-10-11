#!/usr/bin/env bash
#
# Проба места работы (курсоры) в два запуска.
#
# Почему скриптом, а не одним вызовом Electron: в одном процессе окно второго раза
# не поднять — регистрация обработчиков IPC не бывает повторной. Оба запуска
# работают с одним каталогом проекта и сессий, он передаётся переменной окружения.
#
# Это диагностика, а не проверка: она печатает, что получилось, и не падает по
# коду возврата. Судить о результате — по строкам «в сессии» и «курсор после
# перезапуска»: они должны называть один и тот же файл и одну и ту же позицию.

set -u

dir="${CHUI_PROBE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/chui-cursor-XXXXXX")}"
export CHUI_PROBE_DIR="$dir"

echo "[проба] каталог: $dir"

CHUI_PROBE_MODE=save ./node_modules/.bin/electron scripts/cursor-probe.cjs
CHUI_PROBE_MODE=check ./node_modules/.bin/electron scripts/cursor-probe.cjs

rm -rf "$dir"
