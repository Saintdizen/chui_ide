import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../src/shared/languages';
import {
  LSP_PRESETS,
  PYTHON_LSP_PACKAGES,
  lspLanguagesForKind,
  matchPresets,
  mergeLspServers,
  presetCommands,
  type LspServerConfig,
} from '../src/shared/lsp-presets';
import { VENV_INSTALL_OPTIONS } from '../src/shared/python-env';

describe('presetCommands', () => {
  it('без повторов', () => {
    const commands = presetCommands();
    expect(new Set(commands).size).toBe(commands.length);
  });

  it('включает команды Python и TypeScript', () => {
    const commands = presetCommands();
    expect(commands).toContain('pylsp');
    expect(commands).toContain('typescript-language-server');
  });
});

describe('matchPresets', () => {
  it('ничего не найдено — пустой список', () => {
    expect(matchPresets([])).toEqual([]);
  });

  it('на один язык — один сервер (первый по приоритету)', () => {
    // Есть и pylsp, и pyright — берём pylsp (он выше в списке пресетов).
    const result = matchPresets(['pylsp', 'pyright-langserver']);
    const python = result.filter((server) => server.language === 'python');
    expect(python).toHaveLength(1);
    expect(python[0]!.command).toBe('pylsp');
  });

  it('полный путь к серверу в venv привязывается по имени файла', () => {
    // Сервер из окружения приходит полным путём — сопоставляем по имени.
    const result = matchPresets(['/p/.venv/bin/pylsp']);
    const python = result.find((server) => server.language === 'python');
    expect(python?.command).toBe('/p/.venv/bin/pylsp');
  });

  it('расширение .exe на Windows не мешает сопоставлению', () => {
    const result = matchPresets(['C:/p/.venv/Scripts/pylsp.exe']);
    const python = result.find((server) => server.language === 'python');
    expect(python?.command).toBe('C:/p/.venv/Scripts/pylsp.exe');
  });

  it('если pylsp нет, берётся pyright', () => {
    const result = matchPresets(['pyright-langserver']);
    const python = result.find((server) => server.language === 'python');
    expect(python?.command).toBe('pyright-langserver');
    expect(python?.args).toEqual(['--stdio']);
  });

  it('конфигурация готова к использованию: enabled и копия args', () => {
    const result = matchPresets(['typescript-language-server']);
    const ts = result.find((server) => server.language === 'typescript');
    expect(ts).toEqual({
      language: 'typescript',
      command: 'typescript-language-server',
      args: ['--stdio'],
      enabled: true,
    });
  });

  it('посторонние команды игнорируются', () => {
    expect(matchPresets(['ls', 'git', 'node'])).toEqual([]);
  });

  it('js и ts получают один сервер, но разными записями по языку', () => {
    const result = matchPresets(['typescript-language-server']);
    expect(result.map((server) => server.language).sort()).toEqual(['javascript', 'typescript']);
  });

  it('все пресеты уникальны по команде и языку', () => {
    // Один язык не должен иметь двух записей с одинаковым приоритетом случайно.
    const seen = new Set<string>();
    for (const preset of LSP_PRESETS) {
      const key = `${preset.language}:${preset.command}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('языки пресетов есть в реестре языков', () => {
    // Опечатка в идентификаторе языка оставила бы пресет мёртвым: сервер бы
    // находился, а подсказки не появлялись — ни один файл не имеет такого языка.
    const known = new Set(LANGUAGES.map((language) => language.id));
    for (const preset of LSP_PRESETS) {
      expect(known.has(preset.language)).toBe(true);
    }
  });

  it('пресеты покрывают распространённые языки', () => {
    const languages = new Set(LSP_PRESETS.map((preset) => preset.language));
    for (const id of ['python', 'typescript', 'rust', 'go', 'java', 'ruby', 'php', 'csharp', 'xml', 'sql']) {
      expect(languages.has(id)).toBe(true);
    }
  });
});

describe('mergeLspServers', () => {
  const server = (language: string, command = language): LspServerConfig => ({
    language,
    command,
    args: [],
    enabled: true,
  });

  it('пустой список заполняется найденным', () => {
    expect(mergeLspServers([], [server('python', 'pylsp')])).toEqual([server('python', 'pylsp')]);
  });

  it('язык, у которого сервер уже есть, второй раз не добавляется', () => {
    // Два сервера одного языка спорили бы: в рантайме ключ — язык.
    const existing = [server('python', 'pylsp')];
    expect(mergeLspServers(existing, [server('python', '/p/.venv/bin/pylsp')])).toEqual(existing);
  });

  it('настроенный сервер не перебивается найденным', () => {
    // Свой путь, свои аргументы или выключенный сервер — решение человека.
    const existing: LspServerConfig[] = [{ language: 'python', command: 'my-pylsp', args: ['--x'], enabled: false }];
    expect(mergeLspServers(existing, [server('python', 'pylsp')])).toEqual(existing);
  });

  it('недостающий язык добирается, когда список уже не пуст', () => {
    // Ровно этот случай и не работал: сервер TypeScript настроен, а pylsp
    // появился позже — в только что созданном окружении проекта.
    const merged = mergeLspServers([server('typescript')], [server('typescript'), server('python', 'pylsp')]);
    expect(merged.map((item) => item.language)).toEqual(['typescript', 'python']);
    expect(merged[1]!.command).toBe('pylsp');
  });

  it('дописанное идёт в хвост — по длине исходного списка видно, что подключилось', () => {
    const merged = mergeLspServers([server('typescript')], [server('rust'), server('go')]);
    expect(merged.slice(1).map((item) => item.language)).toEqual(['rust', 'go']);
  });

  it('повторный вызов с тем же набором ничего не меняет', () => {
    const existing = [server('typescript'), server('python', 'pylsp')];
    const found = [server('python', 'pylsp'), server('typescript')];
    expect(mergeLspServers(existing, found)).toEqual(existing);
  });

  it('входные списки не меняются', () => {
    const existing = [server('typescript')];
    const found = [server('python', 'pylsp')];
    mergeLspServers(existing, found);
    expect(existing).toHaveLength(1);
    expect(found).toHaveLength(1);
  });
});

describe('lspLanguagesForKind', () => {
  // Общие языки (JSON, YAML, CSS, HTML, Markdown) показываем в проекте любого вида:
  // конфиги и разметка есть везде, а серверы для них едут с IDE. Язык самого проекта
  // идёт вдобавок к ним.
  it('Python-проекту — python и общие языки', () => {
    const languages = lspLanguagesForKind('python')!;
    expect(languages).toContain('python');
    expect(languages).toContain('json');
    expect(languages).not.toContain('typescript');
  });

  it('Node и Deno — js/ts и общие языки', () => {
    for (const kind of ['node', 'deno']) {
      const languages = lspLanguagesForKind(kind)!;
      expect(languages).toContain('typescript');
      expect(languages).toContain('javascript');
      expect(languages).toContain('json');
      expect(languages).not.toContain('python');
    }
  });

  it('неизвестный вид не фильтруется', () => {
    expect(lspLanguagesForKind(null)).toBeNull();
    expect(lspLanguagesForKind('rust')).toBeNull();
  });

  it('каждый язык фильтра есть в пресетах — иначе сервер не подобрать', () => {
    const known = new Set(LSP_PRESETS.map((preset) => preset.language));
    for (const kind of ['python', 'node', 'deno']) {
      for (const id of lspLanguagesForKind(kind) ?? []) expect(known.has(id)).toBe(true);
    }
  });
});

describe('PYTHON_LSP_PACKAGES', () => {
  it('ставит сервер Python и его линтеры', () => {
    // Без плагинов базовый pylsp код не проверяет: диагностику дают pyflakes и pycodestyle.
    expect(PYTHON_LSP_PACKAGES).toContain('python-lsp-server');
    expect(PYTHON_LSP_PACKAGES).toContain('pyflakes');
    expect(PYTHON_LSP_PACKAGES).toContain('pycodestyle');
  });

  it('согласован с пресетом «Полное окружение»', () => {
    // Кнопка установки сервера и пресет окружения не должны разъезжаться.
    const full = VENV_INSTALL_OPTIONS.find((option) => option.id === 'full')!.packages;
    for (const name of PYTHON_LSP_PACKAGES) expect(full).toContain(name);
  });
});
