/**
 * Серверы из поставки IDE: где они лежат и чем их запускать.
 *
 * Список того, ЧТО ставим, живёт в `shared/lsp-bundled.ts`; здесь — «как найти» и
 * «как запустить». Разделение не формальное: список проверяется тестом без диска,
 * а поиск путей и знание про Electron — только тут.
 *
 * Два разных мира, и это главная тонкость файла:
 *
 *   • в разработке `node_modules` лежит прямо в корне проекта и запускается как есть;
 *   • в поставке код упакован в `app.asar`, а `node_modules` — в `app.asar.unpacked`
 *     (иначе процесс из архива не стартует; там же лежит node-pty). Значит корней
 *     для поиска два, и оба надо перебрать.
 *
 * Запускаем JS-серверы не через системный `node` (его может не быть — например, на
 * машине с одним Python), а через сам Electron с `ELECTRON_RUN_AS_NODE=1`: тогда
 * node-режим гарантированно есть в поставке. Переменную кладём в конфиг сервера,
 * поэтому она не задевает питоновские серверы (те её просто не читают).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { LspServerConfig } from '../../shared/api';
import { LSP_BUNDLED_SERVERS, matchBundledServers } from '../../shared/lsp-bundled';
import { resolvePackageBin, resolvePackageFile } from '../node/bin';

/** Имя архива, под которым electron-builder кладёт код. */
const ASAR_SUFFIX = 'app.asar';

/**
 * Каталоги, где искать `node_modules` поставки. Порядок — от самого «распакованного»
 * к исходному: сперва `app.asar.unpacked` (там серверы, которые нельзя запускать из
 * архива), потом сам `app.asar`, потом корень приложения.
 *
 * В разработке `app.getAppPath()` — корень проекта, и первый корень просто не
 * существует: `resolvePackageBin` вернёт null, и поиск пойдёт дальше.
 */
export function installRoots(appPath: string, resourcesPath: string, moduleDir: string = __dirname): string[] {
  const roots: string[] = [];
  if (appPath.endsWith(ASAR_SUFFIX)) {
    roots.push(`${appPath}.unpacked`);
    if (resourcesPath) roots.push(path.join(resourcesPath, `${ASAR_SUFFIX}.unpacked`));
  }
  // Корень, найденный от самого модуля: единственный надёжный способ. `getAppPath()`
  // показывает каталог ЗАПУЩЕННОГО скрипта, поэтому при `electron scripts/…` он укажет
  // на `scripts`, а не на проект, — и поиск серверов промахнётся.
  const fromModule = findPackageRoot(moduleDir);
  if (fromModule) roots.push(fromModule);
  roots.push(appPath);
  return [...new Set(roots)];
}

/** Каталог выше по дереву, в котором лежит `node_modules`. Ближайший — нужный. */
function findPackageRoot(from: string): string | null {
  let dir = from;
  // Глубина с запасом: dist/main/lsp — три уровня до корня, плюс запас на иную сборку.
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, 'node_modules'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Чем запускать JS-сервер: сам Electron в режиме Node. `env` уходит в дочерний
 * процесс — см. пояснение в шапке файла.
 */
export function nodeRuntime(execPath: string): { command: string; env: Record<string, string> } {
  return { command: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Языков, для которых ходим на диск: пары «пакет + имя скрипта» без повторов. */
function wantedScripts(): Array<{ package: string; bin: string }> {
  const seen = new Map<string, { package: string; bin: string }>();
  for (const server of LSP_BUNDLED_SERVERS) {
    seen.set(`${server.package}\0${server.bin}`, { package: server.package, bin: server.bin });
  }
  return [...seen.values()];
}

/**
 * Найти в поставке те серверы, что реально в неё попали. Пустой список — обычное
 * дело (сборка без них), и это не ошибка: PATH-серверы и venv работают как раньше.
 */
export async function detectBundledServers(
  appPath: string = app.getAppPath(),
  resourcesPath: string = process.resourcesPath,
  execPath: string = process.execPath,
): Promise<LspServerConfig[]> {
  const roots = installRoots(appPath, resourcesPath);

  // Первый корень, где файл нашёлся: в поставке это распакованный `app.asar.unpacked`,
  // в разработке — корень проекта. Запоминаем найденное, чтобы не ходить на диск дважды.
  const firstIn = async (lookup: (root: string) => Promise<string | null>): Promise<string | null> => {
    for (const root of roots) {
      const hit = await lookup(root);
      if (hit) return hit;
    }
    return null;
  };

  // `matchBundledServers` работает синхронно, поэтому ищем заранее и держим таблицу.
  const found = new Map<string, string | null>();
  for (const { package: name, bin } of wantedScripts()) {
    found.set(`${name}\0${bin}`, await firstIn((root) => resolvePackageBin(root, name, bin)));
  }
  const tsserverKey = (name: string, file: string) => `${name}\0${file}`;
  for (const server of LSP_BUNDLED_SERVERS) {
    if (!server.tsserver) continue;
    const key = tsserverKey(server.tsserver.package, server.tsserver.file);
    if (found.has(key)) continue;
    found.set(key, await firstIn((root) => resolvePackageFile(root, server.tsserver!.package, server.tsserver!.file)));
  }

  const matches = matchBundledServers({
    bin: (name, bin) => found.get(`${name}\0${bin}`) ?? null,
    file: (name, file) => found.get(tsserverKey(name, file)) ?? null,
  });
  const runtime = nodeRuntime(execPath);
  return matches.map((match) => ({
    language: match.language,
    command: runtime.command,
    args: [match.script, ...match.args],
    enabled: true,
    label: match.label,
    env: runtime.env,
    // Свой tsserver показываем серверу явно: в проекте его может не быть или он
    // окажется слишком новым (см. `BundledServer.tsserver`).
    ...(match.tsserverPath ? { initializationOptions: { tsserver: { path: match.tsserverPath } } } : {}),
  }));
}
