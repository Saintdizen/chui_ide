import { describe, expect, it } from 'vitest';
import { LSP_BUNDLED_SERVERS, matchBundledServers, mergeByPriority, serverCandidates } from '../src/shared/lsp-bundled';
import type { LspServerConfig } from '../src/shared/api';

/**
 * Серверы из поставки: что попадает в список и в каком порядке выбирается сервер
 * одного языка. Файловой системы тут нет — резолвер подставной, поэтому проверяется
 * ровно правило, а не диск.
 */
describe('matchBundledServers', () => {
  /**
   * Резолвер, у которого «есть» ровно перечисленные скрипты. `tsserverExists` —
   * есть ли рядом свой `tsserver.js` (без него TypeScript-сервер не поднимается).
   */
  const resolver = (available: readonly string[], tsserverExists = true) => ({
    bin: (name: string, bin: string) =>
      available.includes(`${name}/${bin}`) ? `/app/node_modules/${name}/${bin}` : null,
    file: (name: string, file: string) => (tsserverExists ? `/app/node_modules/${name}/${file}` : null),
  });

  it('не находит ничего, если серверов нет', () => {
    expect(matchBundledServers(resolver([]))).toEqual([]);
  });

  it('язык попадает в список только со своим скриптом', () => {
    const found = matchBundledServers(resolver(['typescript-language-server/typescript-language-server']));
    const languages = found.map((match) => match.language);
    expect(languages).toContain('typescript');
    expect(languages).toContain('javascript');
    expect(languages).not.toContain('python');
  });

  it('у каждого языка один сервер, даже если пакетов несколько', () => {
    const found = matchBundledServers(
      resolver([
        'typescript-language-server/typescript-language-server',
        'vscode-langservers-extracted/vscode-json-language-server',
      ]),
    );
    expect(found.filter((match) => match.language === 'json')).toHaveLength(1);
  });

  it('TypeScript без своего tsserver не предлагается вовсе', () => {
    // Сервер без tsserver отказывается работать: показать его — значит обещать
    // подсказки, которых не будет.
    const found = matchBundledServers(resolver(['typescript-language-server/typescript-language-server'], false));
    expect(found.map((match) => match.language)).not.toContain('typescript');
  });

  it('путь к tsserver попадает в находку', () => {
    const found = matchBundledServers(resolver(['typescript-language-server/typescript-language-server']));
    expect(found.find((match) => match.language === 'typescript')?.tsserverPath).toBe(
      '/app/node_modules/typescript-bundled/lib/tsserver.js',
    );
  });

  it('в списке нет двух записей одного языка', () => {
    const languages = LSP_BUNDLED_SERVERS.map((server) => server.language);
    // Повтор языка допустим (SCSS и Less — один сервер CSS), но в находке он схлопнется.
    const unique = [...new Set(languages)];
    const found = matchBundledServers(resolver(['vscode-langservers-extracted/vscode-css-language-server']));
    expect(found.filter((match) => match.language === 'css')).toHaveLength(1);
    expect(unique).toContain('css');
  });
});

describe('mergeByPriority', () => {
  const server = (language: string, command: string): LspServerConfig => ({
    language,
    command,
    args: [],
    enabled: true,
  });

  it('у языка остаётся сервер из первого источника', () => {
    const merged = mergeByPriority([
      [server('python', 'venv-pylsp')],
      [server('python', 'bundled-pyright'), server('json', 'bundled-json')],
      [server('python', 'path-pylsp'), server('go', 'gopls')],
    ]);
    const byLanguage = new Map(merged.map((item) => [item.language, item.command]));
    expect(byLanguage.get('python')).toBe('venv-pylsp');
    expect(byLanguage.get('json')).toBe('bundled-json');
    expect(byLanguage.get('go')).toBe('gopls');
  });

  it('порядок результата — по источникам, без повторов языка', () => {
    const merged = mergeByPriority([[server('a', '1')], [server('a', '2'), server('b', '3')]]);
    expect(merged.map((item) => item.language)).toEqual(['a', 'b']);
  });

  it('пустые источники не мешают', () => {
    expect(mergeByPriority([[], [], [server('a', '1')]])).toEqual([server('a', '1')]);
  });
});

describe('serverCandidates', () => {
  const server = (language: string, command: string, enabled = true): LspServerConfig => ({
    language,
    command,
    args: [],
    enabled,
  });

  it('сперва сервер из настроек, затем альтернативы', () => {
    const chain = serverCandidates(
      [server('python', '/p/.venv/bin/pylsp')],
      [server('python', 'electron-pyright'), server('python', 'path-pylsp')],
      'python',
    );
    expect(chain.map((item) => item.command)).toEqual(['/p/.venv/bin/pylsp', 'electron-pyright', 'path-pylsp']);
  });

  it('язык не назван в настройках — берём только альтернативы', () => {
    const chain = serverCandidates([], [server('python', 'electron-pyright')], 'python');
    expect(chain.map((item) => item.command)).toEqual(['electron-pyright']);
  });

  it('тот же сервер дважды не повторяется', () => {
    const chain = serverCandidates([server('python', 'pylsp')], [server('python', 'pylsp')], 'python');
    expect(chain).toHaveLength(1);
  });

  it('выключенный в настройках сервер — альтернативы не навязываем', () => {
    const chain = serverCandidates([server('python', 'pylsp', false)], [server('python', 'pyright')], 'python');
    expect(chain).toEqual([]);
  });

  it('серверы других языков не мешают', () => {
    const chain = serverCandidates([], [server('go', 'gopls'), server('python', 'pyright')], 'python');
    expect(chain.map((item) => item.command)).toEqual(['pyright']);
  });

  it('сервер без команды пропускается', () => {
    const chain = serverCandidates([], [server('python', '  '), server('python', 'pyright')], 'python');
    expect(chain.map((item) => item.command)).toEqual(['pyright']);
  });
});
