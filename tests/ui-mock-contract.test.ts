import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Стража ручного мока интерфейса (`scripts/ui-mock.js`).
 *
 * Мок подменяет мост `window.chui` для просмотра интерфейса в обычном браузере
 * (`page.addInitScript` против `npx vite`). В CI он не участвует, поэтому без
 * стражи легко отстаёт от кода: переименовали метод RPC — мок молча отвечает на
 * старое имя, и экран падает с «нет мока для …» уже во время ручного просмотра.
 *
 * Проверки:
 *   1. каждый ключ мока объявлен в контракте `ChuiMethods` — нет опечаток и
 *      устаревших имён после переименований;
 *   2. в моке нет повторяющихся ключей — в объекте JS дубль молча перекрывает
 *      первый, и один из обработчиков пропадает;
 *   3. каждый метод, который renderer зовёт через `rpc.request`, мок отыгрывает —
 *      КРОМЕ явного списка ниже. Список фиксирует, что именно мок не покрывает и
 *      почему: новый метод без мока роняет тест, а не всплывает в браузере.
 */

const read = (relative: string): string => readFileSync(resolve(process.cwd(), relative), 'utf8');

/** Имена методов, объявленных в интерфейсе `ChuiMethods`. */
function contractMethods(): string[] {
  const source = read('src/shared/api.ts');
  const start = source.indexOf('export interface ChuiMethods');
  expect(start, 'в shared/api.ts нет интерфейса ChuiMethods').toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^\s*'([a-z]+(?:\.[A-Za-z0-9]+)+)'\s*:/gm)].map((match) => match[1]!);
}

/** Ключи, объявленные в объекте мока, вместе с их числом (для проверки повторов). */
function mockKeys(): string[] {
  const source = read('scripts/ui-mock.js');
  return [...source.matchAll(/^\s*'([a-z]+(?:\.[A-Za-z0-9]+)+)'\s*:/gm)].map((match) => match[1]!);
}

/** Методы, которые renderer вызывает через `rpc.request`. */
function calledMethods(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.ts')) {
        const source = readFileSync(path, 'utf8');
        // Пробелы и перевод строки между `rpc` и `.request` допустимы: длинный вызов
        // форматируется в столбик, и страж не должен считать его ненайденным.
        for (const match of source.matchAll(/rpc\s*\.\s*request\(\s*'([a-z]+(?:\.[A-Za-z0-9]+)+)'/g)) {
          found.add(match[1]!);
        }
      }
    }
  };
  walk(resolve(process.cwd(), 'src/renderer'));
  return found;
}

/**
 * Чего в браузерном моке нет — и почему. Это не «забыли»: подсистема требует
 * настоящего бэкенда (отладчик, git-операции над рабочим каталогом, сеть),
 * которого в браузере нет, и подделывать его данными значило бы показывать
 * неправду. Список явный: появление метода вне него (и вне мока) — ошибка.
 */
const NOT_MOCKED: Record<string, string[]> = {
  'отладчик в браузере не работает — нет адаптера': [
    'debug.attach',
    'debug.continue',
    'debug.evaluate',
    'debug.hover',
    'debug.pause',
    'debug.scopes',
    'debug.setBreakpoints',
    'debug.setExceptionBreakpoints',
    'debug.setExpression',
    'debug.setVariable',
    'debug.start',
    'debug.step',
    'debug.stop',
    'debug.variables',
  ],
  'правка импортов и словарь орфографии — файлы и языковой сервер живут в main': [
    'spell.dictionary',
    'workspace.updateImports',
  ],
  'внешние инструменты (MCP) — процессы запускает main': ['ai.mcpTools'],
  'нужен настоящий репозиторий и клиент git — в моке их нет': [
    'git.bisectMark',
    'git.bisectReset',
    'git.bisectStart',
    'git.bisectState',
    'git.rebase',
    'git.rebaseAbort',
    'git.rebaseContinue',
    'git.rebaseSkip',
    'git.sparseAdd',
    'git.sparseDisable',
    'git.sparseInfo',
    'git.sparseSet',
    'git.submoduleUpdate',
    'git.submodules',
    'git.worktreeAdd',
    'git.worktreePrune',
    'git.worktreeRemove',
    'git.worktrees',
  ],
  'git-lfs в окружении просмотра не установлен': [
    'git.lfsInfo',
    'git.lfsInstall',
    'git.lfsPull',
    'git.lfsTrack',
    'git.lfsUntrack',
  ],
  'сеть и удалённые адреса — просмотр UI в браузере их не трогает': [
    'git.fetch',
    'git.fetchRoots',
    'git.pull',
    'git.push',
    'git.remotes',
  ],
  'личность и ключи подписи — чтение системных настроек git': ['git.identity', 'git.setIdentity', 'git.sshKeys'],
  'прочие git-запросы к диску и истории': ['git.summary', 'git.checkIgnore', 'git.compareRefs', 'git.diffRefs'],
  'история файла и ревью — живут на диске проекта': [
    'history.clear',
    'history.list',
    'history.read',
    'review.load',
    'review.save',
  ],
  'профайлер и окружение Python — нужен интерпретатор': ['python.activateCommand', 'python.profileLines'],
  'покрытие тестами — main читает отчёт раннера': ['project.coverageJsonPath', 'project.readCoverage'],
  'пакеты монорепо и многообласть — читаются из файловой системы': [
    'project.packages',
    'workspace.addRoot',
    'workspace.removeRoot',
    'workspace.setActiveRoot',
  ],
  'точные данные от языкового сервера — в браузере сервера нет': ['lsp.formatRange', 'lsp.semanticTokens'],
  'ключи и права ассистента — хранятся в настройках': [
    'ai.setWebSearchKey',
    'ai.clearWebSearchKey',
    'ai.setPermission',
  ],
  'встроенный браузер держит main: вложение — слой окна, а не элемент страницы': [
    'browser.viewCapture',
    'browser.viewClose',
    'browser.viewCloseAll',
    'browser.viewCommand',
    'browser.viewConsole',
    'browser.viewCreate',
    'browser.viewHide',
    'browser.viewLayout',
    'browser.viewPick',
    'browser.viewShare',
    'browser.viewShow',
    'browser.viewUnshare',
    'browser.viewZoom',
  ],
  'обращение наружу и диалог закрытия окна': ['shell.openExternal', 'dialog.confirmClose'],
};

describe('мок интерфейса: согласованность с контрактом RPC', () => {
  it('разбор находит методы (иначе тест проверял бы пустоту)', () => {
    expect(contractMethods().length).toBeGreaterThan(100);
    expect(new Set(mockKeys()).size).toBeGreaterThan(100);
    expect(calledMethods().size).toBeGreaterThan(100);
  });

  it('каждый ключ мока объявлен в контракте', () => {
    const declared = new Set(contractMethods());
    const unknown = mockKeys().filter((method) => !declared.has(method));
    expect(unknown, `в моке есть ключи вне ChuiMethods: ${[...new Set(unknown)].join(', ')}`).toEqual([]);
  });

  it('в моке нет повторяющихся ключей', () => {
    const keys = mockKeys();
    const seen = new Set<string>();
    const duplicates = keys.filter((method) => (seen.has(method) ? true : (seen.add(method), false)));
    expect(duplicates, `в моке повторяются: ${[...new Set(duplicates)].join(', ')}`).toEqual([]);
  });

  it('каждый метод, зовомый renderer, покрыт моком или объяснён в списке', () => {
    const mocked = new Set(mockKeys());
    const explained = new Set(Object.values(NOT_MOCKED).flat());
    const uncovered = [...calledMethods()].filter((method) => !mocked.has(method) && !explained.has(method));
    expect(uncovered, `renderer зовёт, а мока нет и в NOT_MOCKED не объяснено: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('список непокрытого не устарел: там только зовомые методы без мока', () => {
    const mocked = new Set(mockKeys());
    const called = calledMethods();
    const wrong: string[] = [];
    for (const [reason, methods] of Object.entries(NOT_MOCKED)) {
      for (const method of methods) {
        if (!called.has(method)) wrong.push(`${method} (${reason}): renderer его не зовёт`);
        if (mocked.has(method)) wrong.push(`${method} (${reason}): но он есть в моке`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});
