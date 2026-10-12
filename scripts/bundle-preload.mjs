import { build } from 'rolldown';

/**
 * Сборка preload ОДНИМ файлом.
 *
 * Зачем: изоляция процессов требует `sandbox: true` (см. window.ts). В песочнице
 * preload имеет `require` только для встроенных модулей Electron — им нельзя
 * `require('../shared/api')`. Поэтому контракт (имена каналов, ключ моста)
 * вшиваем прямо в файл: наружу остаётся единственный `require('electron')`.
 *
 * Бандлим из исходника, а не из вывода tsc: rolldown читает TypeScript сам,
 * а `import type` из shared/api.ts при этом отпадают (в рантайме из shared нужны
 * только строковые константы). Запускается после `tsc -p tsconfig.main.json`:
 * tsc по-прежнему даёт типовую проверку preload, бандл лишь заменяет dist-файл.
 */
await build({
  input: 'src/preload/index.ts',
  platform: 'node',
  external: ['electron'],
  output: {
    file: 'dist/preload/index.js',
    format: 'cjs',
    sourcemap: true,
  },
});
