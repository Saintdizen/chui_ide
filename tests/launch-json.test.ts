// biome-ignore-all lint/suspicious/noTemplateCurlyInString: строки данных — это ровно те ${...}, что приходят из чужого файла
import { describe, expect, it } from 'vitest';
import { launchConfigs } from '../src/shared/launch-json';

/**
 * Конфигурации отладки чужого проекта. Берём только то, что наш отладчик умеет
 * запустить, и только с путями, которые точно разрешаются: запустить «примерно
 * тот» файл хуже, чем не показать конфигурацию.
 */
const ROOT = '/proj';

const file = (configurations: unknown[]): string => JSON.stringify({ version: '0.2.0', configurations });

describe('launchConfigs', () => {
  it('простая Node-конфигурация', () => {
    const configs = launchConfigs(
      file([{ type: 'node', request: 'launch', name: 'start', program: 'src/a.js' }]),
      ROOT,
    );
    expect(configs).toEqual([{ name: 'start', program: '/proj/src/a.js', args: [], env: {}, stopOnEntry: false }]);
  });

  it('аргументы, cwd и env переносятся', () => {
    const configs = launchConfigs(
      file([
        {
          type: 'node',
          request: 'launch',
          name: 'x',
          program: '${workspaceFolder}/a.js',
          args: ['--flag', '${workspaceFolder}/in.txt'],
          cwd: '${workspaceFolder}/sub',
          env: { PORT: '3000', N: 1 },
        },
      ]),
      ROOT,
    );
    expect(configs[0]).toMatchObject({
      program: '/proj/a.js',
      args: ['--flag', '/proj/in.txt'],
      cwd: '/proj/sub',
      env: { PORT: '3000', N: '1' },
    });
  });

  it('pwa-node и python — свои типы, тоже берём', () => {
    const configs = launchConfigs(
      file([
        { type: 'pwa-node', name: 'a', program: 'a.js' },
        { type: 'python', name: 'b', program: 'main.py' },
      ]),
      ROOT,
    );
    expect(configs.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('chroome и прочие типы пропускаются: их нечем запустить', () => {
    expect(launchConfigs(file([{ type: 'chrome', name: 'web', url: 'http://x' }]), ROOT)).toEqual([]);
  });

  it('attach пропускается: адрес задаёт человек, а не файл', () => {
    expect(launchConfigs(file([{ type: 'node', request: 'attach', name: 'a', program: 'a.js' }]), ROOT)).toEqual([]);
  });

  it('${file} не подставляем: конфигурация без файла не значит ничего', () => {
    expect(launchConfigs(file([{ type: 'node', name: 'cur', program: '${file}' }]), ROOT)).toEqual([]);
  });

  it('конфигурация без program пропускается', () => {
    expect(launchConfigs(file([{ type: 'node', name: 'x' }]), ROOT)).toEqual([]);
  });

  it('абсолютный путь остаётся собой', () => {
    expect(launchConfigs(file([{ type: 'node', name: 'x', program: '/abs/a.js' }]), ROOT)[0]?.program).toBe(
      '/abs/a.js',
    );
  });

  it('stopOnEntry по умолчанию выключен', () => {
    const configs = launchConfigs(file([{ type: 'node', name: 'x', program: 'a.js', stopOnEntry: true }]), ROOT);
    expect(configs[0]?.stopOnEntry).toBe(true);
  });

  it('без name подпись — имя файла', () => {
    expect(launchConfigs(file([{ type: 'node', program: 'src/main.js' }]), ROOT)[0]?.name).toBe('main.js');
  });

  it('комментарии и висячие запятые (JSONC)', () => {
    const text = '{\n// мой запуск\n"configurations":[{"type":"node","name":"a","program":"a.js",},],\n}';
    expect(launchConfigs(text, ROOT).map((c) => c.name)).toEqual(['a']);
  });

  it('битый файл — пусто, а не падение', () => {
    expect(launchConfigs('{"configurations": [', ROOT)).toEqual([]);
    expect(launchConfigs('{"configurations": "нет"}', ROOT)).toEqual([]);
  });
});
