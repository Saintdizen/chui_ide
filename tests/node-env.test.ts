import { describe, expect, it } from 'vitest';
import {
  describeNodeEnvIssues,
  diffNodeDependencies,
  installCommand,
  nodeTypeStripCommand,
  nodeVersionLabel,
  parseNodeManifest,
  parseNodeVersion,
  parsePackageManagerVersion,
  satisfiesNodeRange,
  type NodeDependency,
  type NodeEnvFacts,
  type NodePackage,
} from '../src/shared/node-env';

/**
 * Окружение Node: разбор версий, диапазоны `engines.node`, манифест и проблемы.
 *
 * Всё это — чистые правила, поэтому проверяются без Electron и без диска. Дороже
 * всего ошибиться в двух местах: в сравнении версий (там легко принять 18 за ≥20)
 * и в диагностике — ложная ошибка «нет node_modules» заставит человека зря
 * переустанавливать пакеты.
 */

const dep = (name: string, range: string, dev = false): NodeDependency => ({ name, range, dev });
const pkg = (name: string, version = '1.0.0', dev = false): NodePackage => ({ name, version, dev });

describe('разбор версий', () => {
  it('снимает ведущую v у Node', () => {
    expect(parseNodeVersion('v22.12.0')).toBe('22.12.0');
    expect(parseNodeVersion('v20.0.0\n')).toBe('20.0.0');
    expect(parseNodeVersion('мусор')).toBeNull();
  });

  it('берёт версию из вывода менеджера пакетов', () => {
    expect(parsePackageManagerVersion('10.9.0')).toBe('10.9.0');
    expect(parsePackageManagerVersion('9.1.0\n')).toBe('9.1.0');
    expect(parsePackageManagerVersion('')).toBeNull();
  });

  it('подпись версии — major.minor, а не найденный Node объясняем словами', () => {
    expect(nodeVersionLabel('22.12.5')).toBe('Node 22.12');
    expect(nodeVersionLabel(null)).toBe('Node не найден');
  });
});

describe('nodeTypeStripCommand', () => {
  it('старый Node TypeScript не выполняет — запуска нет', () => {
    expect(nodeTypeStripCommand('20.11.0')).toBeNull();
    expect(nodeTypeStripCommand('22.5.0')).toBeNull();
  });

  it('22.6+ умеет, но пока за флагом', () => {
    expect(nodeTypeStripCommand('22.6.0')).toBe('node --experimental-strip-types');
    expect(nodeTypeStripCommand('22.12.0')).toBe('node --experimental-strip-types');
  });

  it('23.6+ выполняет без флага: стирание типов по умолчанию', () => {
    expect(nodeTypeStripCommand('23.6.0')).toBe('node');
    expect(nodeTypeStripCommand('24.1.0')).toBe('node');
  });

  it('версия неизвестна — обещать нечего', () => {
    expect(nodeTypeStripCommand(null)).toBeNull();
    expect(nodeTypeStripCommand('мусор')).toBeNull();
  });
});

describe('satisfiesNodeRange', () => {
  it('отсекает слишком старую версию', () => {
    expect(satisfiesNodeRange('16.0.0', '>=18')).toBe(false);
    expect(satisfiesNodeRange('18.0.0', '>=18')).toBe(true);
    expect(satisfiesNodeRange('20.5.0', '>=18')).toBe(true);
  });

  it('понимает каретку', () => {
    expect(satisfiesNodeRange('20.10.5', '^20.10')).toBe(true);
    expect(satisfiesNodeRange('20.9.0', '^20.10')).toBe(false);
    expect(satisfiesNodeRange('21.0.0', '^20.10')).toBe(false);
  });

  it('понимает тильду', () => {
    expect(satisfiesNodeRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesNodeRange('1.3.0', '~1.2.3')).toBe(false);
  });

  it('понимает альтернативы и несколько условий', () => {
    expect(satisfiesNodeRange('20.0.0', '20 || 22')).toBe(true);
    expect(satisfiesNodeRange('22.5.0', '20 || 22')).toBe(true);
    expect(satisfiesNodeRange('21.0.0', '20 || 22')).toBe(false);
    expect(satisfiesNodeRange('19.0.0', '>=18 <21')).toBe(true);
    expect(satisfiesNodeRange('22.0.0', '>=18 <21')).toBe(false);
  });

  it('понимает дефисный диапазон', () => {
    expect(satisfiesNodeRange('18.5.0', '18.0.0 - 20.5.0')).toBe(true);
    expect(satisfiesNodeRange('21.0.0', '18.0.0 - 20.5.0')).toBe(false);
  });

  it('понимает запись с пропусками', () => {
    expect(satisfiesNodeRange('1.2.5', '1.2.x')).toBe(true);
    expect(satisfiesNodeRange('1.3.0', '1.2.x')).toBe(false);
  });

  it('неразборчивое или отсутствующее условие не сужает: лучше промолчать', () => {
    expect(satisfiesNodeRange('18.0.0', '*')).toBe(true);
    expect(satisfiesNodeRange('18.0.0', '')).toBe(true);
    expect(satisfiesNodeRange('18.0.0', 'неведомо-что')).toBe(true);
    expect(satisfiesNodeRange(null, '>=18')).toBe(true);
    expect(satisfiesNodeRange('18.0.0', null)).toBe(true);
  });
});

describe('parseNodeManifest', () => {
  it('собирает зависимости и dev-зависимости вместе', () => {
    const manifest = parseNodeManifest(
      JSON.stringify({
        dependencies: { express: '^4.0.0' },
        devDependencies: { vitest: '^5.0.0' },
      }),
    );
    expect(manifest.dependencies).toEqual([dep('express', '^4.0.0', false), dep('vitest', '^5.0.0', true)]);
  });

  it('читает engines.node и поле packageManager', () => {
    const manifest = parseNodeManifest(JSON.stringify({ engines: { node: '>=20' }, packageManager: 'pnpm@9.1.0' }));
    expect(manifest.engines).toBe('>=20');
    expect(manifest.packageManager).toBe('pnpm@9.1.0');
  });

  it('битый JSON — пустой манифест, без падения', () => {
    expect(parseNodeManifest('{ это не json')).toEqual({ dependencies: [], engines: null, packageManager: null });
  });
});

describe('diffNodeDependencies', () => {
  it('делит зависимости на установленные и недостающие', () => {
    const diff = diffNodeDependencies([dep('a', '^1'), dep('b', '^2')], [pkg('a')]);
    expect(diff.present.map((item) => item.name)).toEqual(['a']);
    expect(diff.missing.map((item) => item.name)).toEqual(['b']);
  });

  it('пустой node_modules — все зависимости недостающие', () => {
    expect(diffNodeDependencies([dep('a', '^1')], []).missing).toHaveLength(1);
  });
});

describe('describeNodeEnvIssues', () => {
  const base: NodeEnvFacts = {
    label: 'demo',
    nodeModulesPresent: true,
    nodeModulesFilled: true,
    dependencyCount: 2,
    installedCount: 2,
    engineRange: null,
    nodeVersion: '20.0.0',
    lockfile: 'package-lock.json',
    packageManager: 'npm',
  };

  it('здоровое окружение — пустой список', () => {
    expect(describeNodeEnvIssues(base)).toEqual([]);
  });

  it('нет node_modules при объявленных зависимостях — ошибка с командой установки', () => {
    const issues = describeNodeEnvIssues({
      ...base,
      nodeModulesPresent: false,
      nodeModulesFilled: false,
      installedCount: 0,
    });
    const issue = issues.find((item) => item.kind === 'no-modules');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('npm install');
  });

  it('пустой node_modules при зависимостях — ошибка, а не предупреждение', () => {
    const issues = describeNodeEnvIssues({ ...base, nodeModulesFilled: false, installedCount: 0 });
    expect(issues.find((item) => item.kind === 'empty-modules')?.severity).toBe('error');
  });

  it('часть зависимостей не установлена — предупреждение', () => {
    const issues = describeNodeEnvIssues({ ...base, installedCount: 1 });
    const issue = issues.find((item) => item.kind === 'missing-deps');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('не установлено 1 из 2');
  });

  it('версия Node не под engines.node — предупреждение', () => {
    const issues = describeNodeEnvIssues({ ...base, engineRange: '>=22', nodeVersion: '20.0.0' });
    expect(issues.find((item) => item.kind === 'engine-mismatch')?.severity).toBe('warning');
  });

  it('нет файла блокировки — предупреждение', () => {
    const issues = describeNodeEnvIssues({ ...base, lockfile: null });
    expect(issues.find((item) => item.kind === 'no-lockfile')?.severity).toBe('warning');
  });

  it('нет зависимостей — про node_modules не шумим', () => {
    const issues = describeNodeEnvIssues({
      ...base,
      dependencyCount: 0,
      installedCount: 0,
      nodeModulesPresent: false,
      nodeModulesFilled: false,
    });
    expect(issues.some((item) => item.kind === 'no-modules')).toBe(false);
  });

  it('пустой node_modules без зависимостей — только предупреждение', () => {
    const issues = describeNodeEnvIssues({
      ...base,
      dependencyCount: 0,
      installedCount: 0,
      nodeModulesFilled: false,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('empty-modules');
  });
});

describe('installCommand', () => {
  it('собирает команду установки менеджером проекта', () => {
    expect(installCommand('npm')).toBe('npm install');
    expect(installCommand('pnpm')).toBe('pnpm install');
  });
});
