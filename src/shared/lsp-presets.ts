import type { LspServerConfig } from './api';

/**
 * Известные языковые серверы. Смысл — избавить человека от знания команд:
 * он нажимает «Найти серверы», а IDE проверяет PATH и предлагает найденное.
 *
 * Автозапуска здесь нет намеренно: сервер — внешняя программа, и поднимать её
 * без ведома пользователя нельзя. Мы только подставляем команду, если она
 * действительно есть в PATH.
 */
export interface LspPreset {
  language: string;
  /** Что это за сервер — для подписи в интерфейсе. */
  label: string;
  /** Команда, которую ищем в PATH. */
  command: string;
  args: readonly string[];
}

/**
 * Порядок важен: для языка берётся ПЕРВЫЙ найденный пресет. Поэтому более
 * удобные серверы идут раньше — у Python это `pylsp` (ставится одной pip-командой)
 * и `pyright`, у JS/TS — `typescript-language-server`.
 */
export const LSP_PRESETS: readonly LspPreset[] = [
  { language: 'python', label: 'Python LSP Server (pylsp)', command: 'pylsp', args: [] },
  { language: 'python', label: 'Pyright', command: 'pyright-langserver', args: ['--stdio'] },
  { language: 'python', label: 'Ruff', command: 'ruff', args: ['server'] },
  { language: 'typescript', label: 'TypeScript Language Server', command: 'typescript-language-server', args: ['--stdio'] },
  { language: 'javascript', label: 'TypeScript Language Server', command: 'typescript-language-server', args: ['--stdio'] },
  { language: 'rust', label: 'rust-analyzer', command: 'rust-analyzer', args: [] },
  { language: 'go', label: 'gopls', command: 'gopls', args: [] },
  { language: 'c', label: 'clangd', command: 'clangd', args: [] },
  { language: 'cpp', label: 'clangd', command: 'clangd', args: [] },
  { language: 'shell', label: 'Bash Language Server', command: 'bash-language-server', args: ['start'] },
  { language: 'yaml', label: 'YAML Language Server', command: 'yaml-language-server', args: ['--stdio'] },
  { language: 'json', label: 'JSON Language Server', command: 'vscode-json-language-server', args: ['--stdio'] },
  { language: 'css', label: 'CSS Language Server', command: 'vscode-css-language-server', args: ['--stdio'] },
  { language: 'html', label: 'HTML Language Server', command: 'vscode-html-language-server', args: ['--stdio'] },
  { language: 'lua', label: 'Lua Language Server', command: 'lua-language-server', args: [] },
  { language: 'markdown', label: 'Marksman', command: 'marksman', args: ['server'] },
];

/** Все команды, которые имеет смысл искать в PATH: без повторов. */
export function presetCommands(): string[] {
  return [...new Set(LSP_PRESETS.map((preset) => preset.command))];
}

/**
 * Подобрать конфигурацию по найденным в PATH командам. На каждый язык — один
 * сервер: два сервера одного языка конфликтовали бы (в рантайме ключ — язык).
 */
export function matchPresets(available: Iterable<string>): LspServerConfig[] {
  // Сопоставляем по имени файла: команда может прийти и именем из PATH, и полным
  // путём к бинарнику в venv — в обоих случаях запускать нужно то, что нашли.
  const found = new Map<string, string>();
  for (const item of available) {
    const name = baseName(item).replace(/\.(exe|cmd|bat)$/i, '');
    if (!found.has(name)) found.set(name, item);
  }

  const byLanguage = new Map<string, LspServerConfig>();
  for (const preset of LSP_PRESETS) {
    if (byLanguage.has(preset.language)) continue;
    const command = found.get(preset.command);
    if (!command) continue;
    byLanguage.set(preset.language, {
      language: preset.language,
      command,
      args: [...preset.args],
      enabled: true,
    });
  }

  return [...byLanguage.values()];
}

/** Имя файла без каталога: пути на Windows и POSIX режутся одним правилом. */
function baseName(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  return index < 0 ? target : target.slice(index + 1);
}
