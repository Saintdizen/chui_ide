import { describe, expect, it } from 'vitest';
import { LSP_PRESETS, matchPresets, presetCommands } from '../src/shared/lsp-presets';

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
});
