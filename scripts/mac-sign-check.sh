#!/usr/bin/env bash
#
# Проверка mac-сборки: подпись, архитектура и запуск.
#
# Зачем она есть. Собранный для macOS файл нельзя проверить на Linux, а человек с
# маком не будет делать это на каждый выпуск. Поэтому проверяет машина — тот же
# маковый раннер GitHub, который файл и собрал. Скрипт падает (exit 1), если файл
# окажется таким, каким его нельзя отдать: неподписанным, не той архитектуры или
# незапускающимся.
#
# Что было не так без этой проверки: сборка выходила с `identity: null`, то есть
# вообще без подписи. На Intel такой файл запускался, а на Apple Silicon ядро
# отказывается исполнять неподписанный код, и macOS говорит «файл повреждён,
# переместите в Корзину» — то самое сообщение, которое видит человек.
#
# Запуск: bash scripts/mac-sign-check.sh [папка с dmg, по умолчанию release]

set -uo pipefail

release_dir=${1:-release}
failed=0

fail() {
  echo "  FAIL  $*"
  failed=1
}

ok() {
  echo "  ok    $*"
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Проверка mac-сборки: не macOS, пропускаю"
  exit 0
fi

shopt -s nullglob
dmgs=("$release_dir"/*.dmg)
if [ ${#dmgs[@]} -eq 0 ]; then
  echo "Проверка mac-сборки: в $release_dir нет dmg"
  exit 1
fi

work=$(mktemp -d)
mount="$work/mnt"
mkdir -p "$mount"
cleanup() {
  hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

for dmg in "${dmgs[@]}"; do
  echo "== $(basename "$dmg")"

  if ! hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount" >/dev/null; then
    fail "образ не монтируется: $dmg"
    continue
  fi

  app=$(find "$mount" -maxdepth 1 -name '*.app' -print -quit)
  if [ -z "$app" ]; then
    fail "в образе нет приложения"
    hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
    continue
  fi

  # Копию проверяем, а не сам образ: подпись должна переживать копирование —
  # ровно это и делает человек, перетаскивая приложение в «Программы».
  copy="$work/$(basename "$app")"
  cp -R "$app" "$copy"
  hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true

  # 1. Подпись приложения целиком. --deep — вместе с вложенными бинарниками,
  #    --strict — по всем правилам (иначе «подписано, но невалидно» проходит).
  if codesign --verify --deep --strict --verbose=2 "$copy" 2>"$work/verify.log"; then
    ok "подпись приложения верна"
  else
    fail "подпись неверна:"
    sed 's/^/        /' "$work/verify.log"
  fi

  # 2. Что подпись есть вообще. `identity: null` давал тут «code object is not
  #    signed at all» — и это ровно то, что ломало запуск на Apple Silicon.
  if codesign -dv "$copy" 2>&1 | grep -q '^Signature='; then
    ok "подпись присутствует: $(codesign -dv "$copy" 2>&1 | grep '^Signature=' | head -1)"
  else
    fail "приложение не подписано вовсе (identity: null?)"
  fi

  # 3. Все ДВОИЧНЫЕ файлы внутри подписаны. Одной проверки --deep мало: она смотрит
  #    то, что объявлено в бандле, а распакованные нативные модули и языковые
  #    серверы (node_modules) в него не входят.
  #
  #    Подпись требуем только от МАШИННОГО КОДА: её проверяет ядро, и только у Mach-O.
  #    `bin/vscode-*-language-server` — текстовые node-скрипты с битом выполнения
  #    (`#!/usr/bin/env node`): кода в них нет, запускает их уже подписанный Electron
  #    (см. `nodeRuntime` в `src/main/lsp/bundled.ts`), и codesign такие файлы не
  #    подписывает вовсе. Требовать с них подпись значило валить верную сборку на
  #    пяти «неподписанных» текстовых файлах.
  #
  #    Вид файла определяем по магическим байтам, а не по `file`: её ответ зависит от
  #    версии и базы типов, а отсутствие команды молча пропустило бы ВСЁ — проверка
  #    зелёная при неподписанных бинарниках. Байты читает `od`, он есть всегда.
  #    Магия Mach-O: тонкий бинарник (FEEDFACE/FEEDFACF и обратный порядок) и
  #    universal (CAFEBABE/CAFEBABF — те же числа, что у Java-класса, но здесь это
  #    признак «толстого» файла: заголовок архитектур).
  is_macho() {
    magic=$(od -An -tx1 -N4 "$1" 2>/dev/null | tr -d ' \n')
    case "$magic" in
      feedface | feedfacf | cefaedfe | cffaedfe | cafebabe | bebafeca | cafebabf | fbfa) return 0 ;;
      *) return 1 ;;
    esac
  }

  unsigned=0
  binary=0
  while IFS= read -r file; do
    is_macho "$file" || continue
    binary=$((binary + 1))
    if ! codesign --verify --strict "$file" >/dev/null 2>&1; then
      unsigned=$((unsigned + 1))
      [ "$unsigned" -le 3 ] && fail "не подписан или подпись битая: ${file#"$copy/"}"
    fi
  done < <(
    find "$copy/Contents/Frameworks" "$copy/Contents/MacOS" "$copy/Contents/Resources" -type f \
      \( -name '*.node' -o -name '*.dylib' -o -perm -u+x \) 2>/dev/null
  )
  [ "$unsigned" -eq 0 ] && ok "все двоичные файлы подписаны (проверено Mach-O: $binary)"

  # 4. Архитектура. Имя файла обещает её человеку, а фактическая — та, что внутри.
  exec_name=$(plutil -extract CFBundleExecutable raw "$copy/Contents/Info.plist" 2>/dev/null)
  if [ -z "$exec_name" ] || [ ! -x "$copy/Contents/MacOS/$exec_name" ]; then
    fail "нет главного бинарника Contents/MacOS/${exec_name:-?}"
    continue
  fi
  bin="$copy/Contents/MacOS/$exec_name"
  archs=$(lipo -archs "$bin" 2>/dev/null || echo "?")
  case "$(basename "$dmg")" in
    *arm64*) expected=arm64 ;;
    *x64*) expected=x86_64 ;;
    *) expected="" ;;
  esac
  if [ -z "$expected" ]; then
    ok "архитектура: $archs"
  elif [ "$archs" = "$expected" ]; then
    ok "архитектура совпадает с именем файла: $archs"
  else
    fail "в имени $expected, а внутри $archs"
  fi

  # 5. Запуск. Исполняемый файл с неверной подписью ядро убивает сразу (Killed: 9),
  #    поэтому «бинарник отработал» — это и есть доказательство, что файл не битый.
  #    ELECTRON_RUN_AS_NODE превращает приложение в обычный Node: окно тут не нужно.
  run_log="$work/run.log"
  if ELECTRON_RUN_AS_NODE=1 "$bin" -e 'process.stdout.write("start-ok")' >"$run_log" 2>&1 &&
    grep -q 'start-ok' "$run_log"; then
    ok "бинарник запускается (подпись принята системой)"
  else
    fail "бинарник не запускается — это и есть «файл повреждён»:"
    sed 's/^/        /' "$run_log"
  fi

  # 6. Нативный модуль под эту же архитектуру. Собранный под другую, он грузится
  #    без ошибки до первого обращения к терминалу — и приложение падает у человека.
  pty="$copy/Contents/Resources/app.asar.unpacked/node_modules/node-pty"
  if [ -d "$pty" ]; then
    pty_log="$work/pty.log"
    if ELECTRON_RUN_AS_NODE=1 "$bin" -e 'require(process.argv[1]); process.stdout.write("pty-ok")' "$pty" \
      >"$pty_log" 2>&1 && grep -q 'pty-ok' "$pty_log"; then
      ok "нативный модуль терминала грузится под эту архитектуру"
    else
      fail "нативный модуль терминала не грузится:"
      sed 's/^/        /' "$pty_log"
    fi
  else
    fail "в сборке нет node-pty — терминал не заработает"
  fi

  # 7. Оценка Gatekeeper: у ad-hoc подписи она всегда «rejected», и это НЕ ошибка —
  #    печатаем, чтобы в логе было видно, чего человеку ждать при первом запуске.
  echo "        Gatekeeper: $(spctl --assess --type execute -vv "$copy" 2>&1 | tr '\n' ' ' | cut -c1-120)"
  rm -rf "$copy"
done

if [ "$failed" -ne 0 ]; then
  echo "Проверка mac-сборки: есть провалы — такой файл отдавать нельзя"
  exit 1
fi

echo "Проверка mac-сборки прошла: подпись, архитектура и запуск в порядке"
