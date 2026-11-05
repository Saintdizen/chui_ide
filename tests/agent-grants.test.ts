import { describe, expect, it } from 'vitest';
import {
  addEditGrant,
  addGrant,
  type CommandGrant,
  decisionAllowed,
  decisionRemember,
  describeEditGrant,
  describeGrant,
  editGrantMatches,
  grantMatches,
  MAX_COMMAND_GRANTS,
  matchesGrant,
  matchingEditGrant,
  normalizeCommand,
  normalizeEditGrants,
  normalizeGrants,
  rememberedEditGrant,
  removeEditGrant,
  removeGrant,
} from '../src/shared/agent-grants';

describe('normalizeCommand', () => {
  it('лишние пробелы не делают команду новой', () => {
    expect(normalizeCommand('  npm   test  ')).toBe('npm test');
  });
});

describe('разрешения на правку', () => {
  it('«этот файл» — только он, и путь сравнивается без хвостового слеша', () => {
    const grant = rememberedEditGrant('file', '/p/src/a.ts');
    expect(editGrantMatches(grant, '/p/src/a.ts')).toBe(true);
    expect(editGrantMatches(grant, '/p/src/b.ts')).toBe(false);
    expect(editGrantMatches(grant, '/p/src/a.ts/')).toBe(true);
  });

  it('«эта папка» — по границе сегмента, а не по префиксу строки', () => {
    const grant = rememberedEditGrant('dir', '/p/src');
    expect(editGrantMatches(grant, '/p/src/deep/a.ts')).toBe(true);
    expect(editGrantMatches(grant, '/p/src-secret/a.ts')).toBe(false);
  });

  it('первое подходящее разрешение ищется в списке целиком', () => {
    const grants = [rememberedEditGrant('file', '/p/a.ts'), rememberedEditGrant('dir', '/p/src')];
    expect(matchingEditGrant(grants, '/p/src/deep/b.ts')).toEqual({ scope: 'dir', value: '/p/src' });
    expect(matchingEditGrant(grants, '/p/other.ts')).toBeNull();
  });

  it('повтор не копится: одно разрешение — одна строка в списке', () => {
    const once = addEditGrant([], rememberedEditGrant('file', '/p/a.ts'));
    const twice = addEditGrant(once, rememberedEditGrant('file', '/p/a.ts'));
    expect(twice).toEqual([{ scope: 'file', value: '/p/a.ts' }]);
  });

  it('убрать разрешение можно по месту в списке', () => {
    const grants = [rememberedEditGrant('file', '/p/a.ts'), rememberedEditGrant('dir', '/p/src')];
    expect(removeEditGrant(grants, 0)).toEqual([{ scope: 'dir', value: '/p/src' }]);
  });

  it('мусор из файла настроек отбрасывается, а не ломает чтение', () => {
    expect(
      normalizeEditGrants([
        { scope: 'file', value: '/p/a.ts' },
        { scope: 'always', value: '/p' },
        { scope: 'dir', value: '   ' },
        null,
        'строка',
      ]),
    ).toEqual([{ scope: 'file', value: '/p/a.ts' }]);
  });

  it('в настройках — понятной строкой', () => {
    expect(describeEditGrant({ scope: 'file', value: '/p/a.ts' })).toBe('файл: /p/a.ts');
    expect(describeEditGrant({ scope: 'dir', value: '/p/src' })).toBe('папка: /p/src');
  });
});

describe('grantMatches', () => {
  const command = { command: 'npm test', cwd: '/home/u/proj' };

  it('«эта команда» — только точно она', () => {
    const grant: CommandGrant = { scope: 'command', value: 'npm test' };
    expect(grantMatches(grant, command)).toBe(true);
    expect(grantMatches(grant, { ...command, command: 'npm run build' })).toBe(false);
  });

  it('пробелы в набранной команде не отменяют разрешение', () => {
    const grant: CommandGrant = { scope: 'command', value: 'npm test' };
    expect(grantMatches(grant, { ...command, command: 'npm    test' })).toBe(true);
  });

  it('«эта папка» — она и всё внутри, но не соседня папка', () => {
    const grant: CommandGrant = { scope: 'dir', value: '/home/u/proj' };
    expect(grantMatches(grant, command)).toBe(true);
    expect(grantMatches(grant, { ...command, cwd: '/home/u/proj/src/deep' })).toBe(true);
    expect(grantMatches(grant, { ...command, cwd: '/home/u/proj2' })).toBe(false);
  });

  it('«всегда» не глядит ни на команду, ни на папку', () => {
    expect(grantMatches({ scope: 'all' }, { command: 'rm -rf /', cwd: '/tmp' })).toBe(true);
  });
});

describe('matchesGrant', () => {
  it('пустой список — нечего пропускать', () => {
    expect(matchesGrant(undefined, { command: 'ls' })).toBe(false);
    expect(matchesGrant([], { command: 'ls' })).toBe(false);
  });
});

describe('addGrant', () => {
  it('повторное разрешение не плодит строки', () => {
    const once = addGrant([], { scope: 'command', value: 'npm test' });
    expect(addGrant(once, { scope: 'command', value: 'npm  test' })).toHaveLength(1);
  });

  it('список ограничен: давние разрешения вытесняются', () => {
    let list: CommandGrant[] = [];
    for (let i = 0; i < MAX_COMMAND_GRANTS + 5; i += 1) list = addGrant(list, { scope: 'command', value: `cmd${i}` });
    expect(list).toHaveLength(MAX_COMMAND_GRANTS);
    expect(list.at(-1)?.value).toBe(`cmd${MAX_COMMAND_GRANTS + 4}`);
  });
});

describe('removeGrant', () => {
  it('убирает по месту и не трогает чужие', () => {
    const list: CommandGrant[] = [
      { scope: 'command', value: 'a' },
      { scope: 'dir', value: '/tmp' },
    ];
    expect(removeGrant(list, 0)).toEqual([{ scope: 'dir', value: '/tmp' }]);
  });
});

describe('normalizeGrants', () => {
  it('мусор из файла настроек выкидывается', () => {
    expect(normalizeGrants([null, 'x', { scope: 'nope' }, { scope: 'command' }])).toEqual([]);
  });

  it('своё остаётся, лишние пробелы обрезаются', () => {
    expect(
      normalizeGrants([
        { scope: 'command', value: '  npm test ' },
        { scope: 'all', value: 'мусор' },
      ]),
    ).toEqual([{ scope: 'command', value: 'npm test' }, { scope: 'all' }]);
  });
});

describe('describeGrant', () => {
  it('текст говорит то, что реально разрешено', () => {
    expect(describeGrant({ scope: 'command', value: 'npm test' })).toContain('npm test');
    expect(describeGrant({ scope: 'dir', value: '/home/u/proj' })).toContain('/home/u/proj');
    expect(describeGrant({ scope: 'all' })).toContain('все');
  });
});

describe('decision', () => {
  it('старый boolean и новый объект читаются одинаково', () => {
    expect(decisionAllowed(true)).toBe(true);
    expect(decisionAllowed({ allowed: false })).toBe(false);
    expect(decisionRemember(true)).toBeUndefined();
    expect(decisionRemember({ allowed: true, remember: 'dir' })).toBe('dir');
  });
});
