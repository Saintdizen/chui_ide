/**
 * Языковые серверы, которые едут ВМЕСТЕ с IDE (шаг «из коробки»).
 *
 * Смысл простой: часть серверов — обычные npm-пакеты, их можно положить в
 * поставку и запускать без единой установки со стороны человека. Тогда навигация,
 * подсказки и переход к определению работают сразу после установки IDE.
 *
 * Что сюда попадает, а что нет:
 *
 *   • JS/TS, JSON, CSS, HTML, YAML и Python (Pyright) — всё это npm-пакеты, они
 *     запускаются на Node, который уже есть внутри Electron. Едут с IDE;
 *   • `pylsp` — НЕ едет: это питоновский пакет, ему нужен интерпретатор Python.
 *     Его по-прежнему ставит человек кнопкой в настройках (см. `PYTHON_LSP_PACKAGES`).
 *
 * Данные отделены от поиска файлов (`main/lsp/bundled.ts`): здесь только «что за
 * сервер», а «где он лежит» знает main. Так список виден тестам без диска.
 */

import type { LspServerConfig } from './api';

/** Сервер, который можно положить в поставку: npm-пакет и имя его скрипта. */
export interface BundledServer {
  language: string;
  label: string;
  /** Имя npm-пакета в `node_modules`. */
  package: string;
  /** Имя поля `bin` в `package.json` пакета — по нему находится скрипт. */
  bin: string;
  args: readonly string[];
  /**
   * Скрипт `tsserver`, который надо назвать серверу явно.
   *
   * Одному TypeScript Language Server нужен сам `tsserver.js`, а ищет он его в
   * TypeScript ПРОЕКТА. У проекта может стоять слишком новый TypeScript (в 7-й
   * ветке `tsserver.js` вообще нет) или его может не быть вовсе — тогда сервер
   * откажется работать. Поэтому везём свой TypeScript и показываем путь к нему
   * через `initializationOptions.tsserver.path`.
   */
  tsserver?: { package: string; file: string };
}

/**
 * Порядок: с сервером одного языка работаем по первому совпадению (как у пресетов).
 * Pyright идёт до прочих питоновских потому, что он единственный, кто едет с IDE.
 */
export const LSP_BUNDLED_SERVERS: readonly BundledServer[] = [
  {
    language: 'typescript',
    label: 'TypeScript Language Server',
    package: 'typescript-language-server',
    bin: 'typescript-language-server',
    args: ['--stdio'],
    tsserver: { package: 'typescript-bundled', file: 'lib/tsserver.js' },
  },
  {
    language: 'javascript',
    label: 'TypeScript Language Server',
    package: 'typescript-language-server',
    bin: 'typescript-language-server',
    args: ['--stdio'],
    tsserver: { package: 'typescript-bundled', file: 'lib/tsserver.js' },
  },
  {
    language: 'python',
    label: 'Pyright',
    package: 'pyright',
    bin: 'pyright-langserver',
    args: ['--stdio'],
  },
  {
    language: 'json',
    label: 'JSON Language Server',
    package: 'vscode-langservers-extracted',
    bin: 'vscode-json-language-server',
    args: ['--stdio'],
  },
  {
    language: 'css',
    label: 'CSS Language Server',
    package: 'vscode-langservers-extracted',
    bin: 'vscode-css-language-server',
    args: ['--stdio'],
  },
  // SCSS и Less — диалекты CSS: их обслуживает тот же сервер.
  {
    language: 'scss',
    label: 'CSS Language Server',
    package: 'vscode-langservers-extracted',
    bin: 'vscode-css-language-server',
    args: ['--stdio'],
  },
  {
    language: 'less',
    label: 'CSS Language Server',
    package: 'vscode-langservers-extracted',
    bin: 'vscode-css-language-server',
    args: ['--stdio'],
  },
  {
    language: 'html',
    label: 'HTML Language Server',
    package: 'vscode-langservers-extracted',
    bin: 'vscode-html-language-server',
    args: ['--stdio'],
  },
  {
    language: 'yaml',
    label: 'YAML Language Server',
    package: 'yaml-language-server',
    bin: 'yaml-language-server',
    args: ['--stdio'],
  },
];

/** Найденный сервер поставки: путь к скрипту вместо команды. */
export interface BundledMatch {
  language: string;
  label: string;
  /** Полный путь к JS-скрипту сервера. */
  script: string;
  args: readonly string[];
  /** Путь к своему `tsserver.js`, если сервер его требует (см. `BundledServer.tsserver`). */
  tsserverPath?: string;
}

/**
 * Как искать файлы поставки. Два способа, потому что и ищем по-разному: скрипт
 * сервера — по полю `bin` пакета, а `tsserver.js` — прямо по пути внутри пакета.
 */
export interface BundledResolver {
  bin(packageName: string, bin: string): string | null;
  file(packageName: string, relativePath: string): string | null;
}

/**
 * Что из списка поставки реально нашлось. Резолвер отдаём параметром, чтобы список
 * проверялся тестом без файловой системы.
 */
export function matchBundledServers(resolver: BundledResolver): BundledMatch[] {
  const byLanguage = new Map<string, BundledMatch>();
  for (const server of LSP_BUNDLED_SERVERS) {
    if (byLanguage.has(server.language)) continue;
    const script = resolver.bin(server.package, server.bin);
    if (!script) continue;
    // Без своего tsserver сервер TS работать не станет, а тихо поднять его и молчать —
    // хуже, чем не предлагать вовсе: человек будет ждать подсказок, которых нет.
    const tsserverPath = server.tsserver ? resolver.file(server.tsserver.package, server.tsserver.file) : undefined;
    if (server.tsserver && !tsserverPath) continue;
    byLanguage.set(server.language, {
      language: server.language,
      label: server.label,
      script,
      args: [...server.args],
      ...(tsserverPath ? { tsserverPath } : {}),
    });
  }
  return [...byLanguage.values()];
}

/**
 * Свести несколько источников серверов в один список по приоритету: у каждого языка
 * берём сервер из ПЕРВОГО источника, где он есть. Порядок источников задаёт вызывающий —
 * это и есть «откуда предпочитаем брать».
 *
 * Приоритет нужен потому, что в рантайме ключ — язык: два сервера одного языка спорили
 * бы за один документ. А брать предпочтительно то, что ближе к проекту (venv), затем —
 * поставку IDE, затем — систему в PATH.
 */
export function mergeByPriority(sources: ReadonlyArray<readonly LspServerConfig[]>): LspServerConfig[] {
  const taken = new Set<string>();
  const result: LspServerConfig[] = [];
  for (const source of sources) {
    for (const server of source) {
      if (taken.has(server.language)) continue;
      taken.add(server.language);
      result.push({ ...server, args: [...server.args] });
    }
  }
  return result;
}

/**
 * Цепочка серверов для языка: что пробовать по очереди, пока один не поднимется.
 *
 * `mergeByPriority` оставляет у языка ОДИН сервер — этого мало в рантайме: сервер
 * может оказаться нерабочим. Живой пример — `pylsp` из venv, падающий на
 * `initialize`: с одним сервером язык остаётся без подсказок вовсе. Поэтому у
 * рантайма есть цепочка: сперва названное в настройках, затем альтернативы из
 * остальных источников (поставка, PATH) — берётся первый поднявшийся.
 *
 * Выключенный сервер — воля человека: если язык назван в настройках, но все его
 * серверы выключены, цепочка пуста (альтернативы не навязываем).
 */
export function serverCandidates(
  configured: readonly LspServerConfig[],
  alternates: readonly LspServerConfig[],
  language: string,
): LspServerConfig[] {
  const own = configured.filter((server) => server.language === language);
  if (own.length > 0 && !own.some((server) => server.enabled && server.command.trim())) return [];

  const seen = new Set<string>();
  const result: LspServerConfig[] = [];
  for (const server of [...own, ...alternates]) {
    if (server.language !== language) continue;
    if (!server.enabled || !server.command.trim()) continue;
    const key = `${server.command}\0${server.args.join('\0')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(server);
  }
  return result;
}

/**
 * Языки проекта, у которых есть сервер в настройках — те, что имеет смысл греть заранее.
 *
 * Нужно при открытии проекта: серверы языков проекта поднимаются сразу, а не при первом
 * открытии файла. Язык без сервера отбрасываем: поднимать для него нечего, а пометка
 * «сервер не найден» засорила бы статус. Выключенный сервер — воля человека, его тоже
 * пропускаем. Повторы убираем: языки приходят из карты проекта, где одного языка нет дважды,
 * но функция чистая и полагаться на это не должна.
 */
export function prewarmLanguages(languages: readonly string[], configured: readonly LspServerConfig[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const language of languages) {
    if (seen.has(language)) continue;
    seen.add(language);
    if (serverCandidates(configured, [], language).length > 0) result.push(language);
  }
  return result;
}
