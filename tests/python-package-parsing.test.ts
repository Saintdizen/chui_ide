import { describe, expect, it } from 'vitest';
import {
  canonicalName,
  diffRequirements,
  packageForModule,
  parsePipList,
  parseRequirements,
  requirementsNote,
} from '../src/shared/python-packages';

describe('parsePipList', () => {
  it('разбирает JSON-массив pip', () => {
    const output = '[{"name": "pytest", "version": "6.2.4"}, {"name": "funcy", "version": "1.16"}]';
    expect(parsePipList(output)).toEqual([
      { name: 'pytest', version: '6.2.4' },
      { name: 'funcy', version: '1.16' },
    ]);
  });

  it('предупреждения pip перед JSON не мешают', () => {
    const output = 'WARNING: something\n[{"name": "ruff", "version": "0.16.10"}]';
    expect(parsePipList(output)).toEqual([{ name: 'ruff', version: '0.16.10' }]);
  });

  it('мусор и пустой вывод — пустой список', () => {
    expect(parsePipList('не json')).toEqual([]);
    expect(parsePipList('')).toEqual([]);
  });
});

describe('parseRequirements', () => {
  it('берёт пакеты и спецификаторы версии', () => {
    const text = ['# комментарий', 'funcy==1.16', 'pydantic[dotenv]==1.8.2', 'requests>=2,<3'].join('\n');
    expect(parseRequirements(text)).toEqual([
      { name: 'funcy', specifier: '==1.16', line: 2 },
      { name: 'pydantic', specifier: '==1.8.2', line: 3 },
      { name: 'requests', specifier: '>=2,<3', line: 4 },
    ]);
  });

  it('флаги, ссылки и пути пропускаются', () => {
    const text = ['-r base.txt', '-e .', 'pkg @ https://example.com/pkg.whl', 'git+https://x/y.git'].join('\n');
    expect(parseRequirements(text)).toEqual([]);
  });

  it('хвостовой комментарий отрезается', () => {
    expect(parseRequirements('pytest==7  # тесты')).toEqual([{ name: 'pytest', specifier: '==7', line: 1 }]);
  });
});

describe('canonicalName', () => {
  it('регистр и разделители не важны (PEP 503)', () => {
    expect(canonicalName('PyYAML')).toBe('pyyaml');
    expect(canonicalName('python_dotenv')).toBe('python-dotenv');
    expect(canonicalName('zope.interface')).toBe('zope-interface');
  });
});

describe('diffRequirements', () => {
  it('делит на отсутствующие, лишние и совпавшие', () => {
    const requirements = parseRequirements('pytest==7\nfuncy==1.16');
    const installed = [
      { name: 'pytest', version: '7.0.0' },
      { name: 'requests', version: '2.31.0' },
    ];
    const diff = diffRequirements(requirements, installed);
    expect(diff.missing.map((item) => item.name)).toEqual(['funcy']);
    expect(diff.extra.map((item) => item.name)).toEqual(['requests']);
    expect(diff.present.map((item) => item.name)).toEqual(['pytest']);
  });

  it('сравнение не зависит от регистра и разделителей', () => {
    const requirements = parseRequirements('PyYAML');
    const installed = [{ name: 'pyyaml', version: '6.0' }];
    expect(diffRequirements(requirements, installed).missing).toEqual([]);
  });
});

describe('requirementsNote', () => {
  const installed = (names: string[]) => names.map((name) => ({ name, version: '1.0' }));

  it('всё установлено — так и говорим, с числом', () => {
    const diff = diffRequirements(parseRequirements('pytest\nfuncy'), installed(['pytest', 'funcy']));
    expect(requirementsNote(diff)).toBe('Установлено всё из requirements.txt (2)');
  });

  it('перечисляет недостающие имена', () => {
    const diff = diffRequirements(parseRequirements('pytest\nfuncy\nrequests'), installed(['pytest']));
    expect(requirementsNote(diff)).toBe('Не хватает 2 из 3: funcy, requests');
  });

  it('длинный список обрезается по limit с остатком', () => {
    const diff = diffRequirements(parseRequirements('a\nb\nc\nd'), installed([]));
    expect(requirementsNote(diff, 2)).toBe('Не хватает 4 из 4: a, b и ещё 2');
  });
});

describe('packageForModule', () => {
  it('знает частые расхождения модуль → пакет', () => {
    expect(packageForModule('yaml')).toBe('PyYAML');
    expect(packageForModule('PIL')).toBe('Pillow');
    expect(packageForModule('cv2')).toBe('opencv-python');
  });

  it('регистр не важен', () => {
    expect(packageForModule('YAML')).toBe('PyYAML');
  });

  it('неизвестный модуль остаётся собой', () => {
    expect(packageForModule('mymodule')).toBe('mymodule');
  });
});

