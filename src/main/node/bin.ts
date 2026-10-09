import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Путь к скрипту из поля `bin` пакета в `node_modules` проекта.
 *
 * Инструменты проекта запускаем их же скриптом, а не шимом из `.bin`: на Windows
 * там лежат `.cmd`, и полагаться на их разрешение в оболочке незачем. Имени файла
 * тоже не знаем заранее — оно у пакетов менялось (`bin-prettier.js` →
 * `bin/prettier.cjs`, `bin/jest.js`), а поле `bin` в `package.json` стабильно.
 *
 * null — пакета нет, он не установлен или `bin` не назвал такой команды: во всех
 * случаях это «инструмента нет», а не ошибка.
 */
export async function resolvePackageBin(root: string, packageName: string, binName: string): Promise<string | null> {
  const dir = path.join(root, 'node_modules', packageName);
  const text = await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null);
  if (text === null) return null;

  let bin: unknown;
  try {
    bin = (JSON.parse(text) as { bin?: unknown }).bin;
  } catch {
    return null;
  }

  const relative =
    typeof bin === 'string'
      ? bin
      : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>)[binName] === 'string'
        ? (bin as Record<string, string>)[binName]
        : null;
  if (!relative) return null;

  const script = path.resolve(dir, relative);
  return fs
    .stat(script)
    .then((stat) => (stat.isFile() ? script : null))
    .catch(() => null);
}
