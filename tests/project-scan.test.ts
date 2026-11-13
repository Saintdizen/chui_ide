import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listProjectFiles } from '../src/main/project/scan';
import {
  buildScan,
  countLanguages,
  detectMarkers,
  detectProjectKind,
  findEntryPoints,
  isIgnoredDirectory,
  isTestFile,
  parentDir,
  topLevelDirs,
} from '../src/shared/project-scan';

describe('isIgnoredDirectory', () => {
  it('служебные каталоги не обходим', () => {
    for (const name of ['node_modules', '.git', 'dist', '__pycache__', '.venv', 'venv', '.pytest_cache']) {
      expect(isIgnoredDirectory(name)).toBe(true);
    }
  });

  it('обычные каталоги проекта обходим', () => {
    for (const name of ['src', 'tests', 'app', 'docs']) {
      expect(isIgnoredDirectory(name)).toBe(false);
    }
  });

  // `main.ts` — точка входа renderer (vite/webpack-шаблоны). Без неё карта
  // проекта показывала только main/preload и умалчивала о самом крупном коде.
  it('точка входа renderer по имени main.ts находится', () => {
    const found = findEntryPoints(['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/main.ts']);
    expect(found).toContain('src/renderer/main.ts');
  });

  it('стандартная библиотека внутри venv не считается кодом проекта', () => {
    expect(isIgnoredDirectory('lib/python3.12')).toBe(true);
  });
});

describe('isTestFile', () => {
  it('соглашения pytest и unittest', () => {
    expect(isTestFile('test_parser.py')).toBe(true);
    expect(isTestFile('parser_test.py')).toBe(true);
    expect(isTestFile('src/parser.py')).toBe(false);
  });

  it('соглашения jest и vitest', () => {
    expect(isTestFile('chat.test.ts')).toBe(true);
    expect(isTestFile('chat.spec.tsx')).toBe(true);
    expect(isTestFile('src/chat.ts')).toBe(false);
  });

  it('каталог тестов — признак для Node, но не для Python', () => {
    // pytest собирает по имени, а в `tests/` рядом лежат `conftest.py` и хелперы:
    // пометив их тестами, меню запуска предложило бы файл, где тестов нет.
    expect(isTestFile('tests/helper.py')).toBe(false);
    expect(isTestFile('tests/test_main.py')).toBe(true);
    expect(isTestFile('src/__tests__/util.js')).toBe(true);
    expect(isTestFile('src/helper.py')).toBe(false);
  });
});

describe('parentDir', () => {
  it('каталог файла, пусто для файла в корне', () => {
    expect(parentDir('tests/unit/test_a.py')).toBe('tests/unit');
    expect(parentDir('test_a.py')).toBe('');
  });
});

describe('countLanguages', () => {
  it('по убыванию числа файлов', () => {
    const files = ['a.py', 'b.py', 'c.py', 'main.js', 'style.css'];
    expect(countLanguages(files)).toEqual([
      { id: 'python', label: 'Python', files: 3 },
      { id: 'css', label: 'CSS', files: 1 },
      { id: 'javascript', label: 'JavaScript', files: 1 },
    ]);
  });

  it('при равном числе файлов порядок алфавитный и воспроизводимый', () => {
    const files = ['b.js', 'a.py'];
    expect(countLanguages(files).map((item) => item.id)).toEqual(['javascript', 'python']);
  });

  it('файлы без языка не считаются', () => {
    expect(countLanguages(['LICENSE', 'data.bin'])).toEqual([]);
  });
});

describe('detectMarkers', () => {
  it('опознаёт Python по манифесту в корне', () => {
    const markers = detectMarkers(['pyproject.toml', 'src/app.py']);
    expect(markers).toEqual([{ id: 'python', label: 'Python (pyproject)', file: 'pyproject.toml' }]);
  });

  it('манифест в подпапке не приписывается корню', () => {
    expect(detectMarkers(['sub/package.json'])).toEqual([]);
  });

  it('порядок маркеров устойчив', () => {
    const markers = detectMarkers(['package.json', 'pyproject.toml', 'Dockerfile']);
    expect(markers.map((item) => item.id)).toEqual(['python', 'node', 'docker']);
  });
});

describe('detectProjectKind', () => {
  /** Вид проекта прямо из списка файлов — тем же путём, что и в скане. */
  const kindOf = (files: string[]) => detectProjectKind(detectMarkers(files), countLanguages(files));

  it('Python по манифесту в корне', () => {
    expect(kindOf(['pyproject.toml', 'app/main.py'])).toEqual({
      id: 'python',
      label: 'Python (pyproject)',
      source: 'marker',
      file: 'pyproject.toml',
    });
  });

  it('манифест-тулинг не перебивает главный язык', () => {
    // package.json у Python-проекта — это тулинг: код здесь на Python.
    const kind = kindOf(['package.json', 'pyproject.toml', 'a.py', 'b.py', 'c.py', 'web/index.ts']);
    expect(kind.id).toBe('python');
  });

  it('Node по package.json и коду на TypeScript', () => {
    expect(kindOf(['package.json', 'src/index.ts', 'src/util.ts'])).toEqual({
      id: 'node',
      label: 'Node.js',
      source: 'marker',
      file: 'package.json',
    });
  });

  it('без манифестов судим по языку', () => {
    expect(kindOf(['src/main.rs', 'src/lib.rs'])).toEqual({ id: 'rust', label: 'Rust', source: 'language' });
  });

  it('пустой проект — unknown', () => {
    expect(kindOf(['LICENSE'])).toEqual({ id: 'unknown', label: 'Неизвестно', source: 'none' });
  });
});

describe('findEntryPoints', () => {
  it('находит знакомые имена точек входа', () => {
    const files = ['src/main.py', 'app/manage.py', 'README.md', 'tool.js'];
    expect(findEntryPoints(files)).toEqual(['src/main.py', 'app/manage.py']);
  });

  it('уважает предел списка', () => {
    const files = ['a/main.py', 'b/main.py', 'c/main.py'];
    expect(findEntryPoints(files, 2)).toHaveLength(2);
  });
});

describe('topLevelDirs', () => {
  it('каталоги верхнего уровня, где больше файлов — выше', () => {
    expect(topLevelDirs(['src/a.ts', 'src/b.ts', 'tests/a.test.ts', 'README.md'])).toEqual(['src', 'tests']);
  });

  it('файлы в корне каталогами не считаются', () => {
    expect(topLevelDirs(['main.py', 'util.py'])).toEqual([]);
  });

  it('глубже первого уровня не идём', () => {
    expect(topLevelDirs(['src/main/index.ts', 'src/renderer/app.ts'])).toEqual(['src']);
  });

  it('уважает предел списка', () => {
    expect(topLevelDirs(['a/x.ts', 'b/x.ts', 'c/x.ts'], 2)).toHaveLength(2);
  });
});

describe('buildScan', () => {
  it('собирает сводку из списка файлов', () => {
    const scan = buildScan({
      root: '/project',
      name: 'project',
      files: ['pyproject.toml', 'app/main.py', 'tests/test_main.py', 'tests/unit/test_x.py', 'notes.txt'],
      dirCount: 3,
    });

    expect(scan).toEqual({
      root: '/project',
      name: 'project',
      fileCount: 5,
      dirCount: 3,
      languages: [
        { id: 'python', label: 'Python', files: 3 },
        { id: 'ini', label: 'TOML / INI', files: 1 },
      ],
      markers: [{ id: 'python', label: 'Python (pyproject)', file: 'pyproject.toml' }],
      kind: { id: 'python', label: 'Python (pyproject)', source: 'marker', file: 'pyproject.toml' },
      testFiles: ['tests/test_main.py', 'tests/unit/test_x.py'],
      testDirs: ['tests', 'tests/unit'],
      entryPoints: ['app/main.py'],
      topDirs: ['tests', 'app'],
    });
  });

  it('проект без тестов и точек входа — пустые списки', () => {
    const scan = buildScan({ root: '/empty', name: 'empty', files: ['README.md'], dirCount: 0 });
    expect(scan.testFiles).toEqual([]);
    expect(scan.testDirs).toEqual([]);
    expect(scan.entryPoints).toEqual([]);
    expect(scan.markers).toEqual([]);
  });
});

describe('listProjectFiles', () => {
  // Имена каталогов нужны сборке промпта: без них ссылки вида `src/shared`
  // в AGENTS.md объявляются битыми, хотя каталог есть. Раньше их никто не
  // проверял — возвращался только `dirCount`.
  it('возвращает имена каталогов, а не только их количество', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-scan-'));
    try {
      fs.mkdirSync(path.join(root, 'src', 'shared'), { recursive: true });
      fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'shared', 'api.ts'), '');
      fs.writeFileSync(path.join(root, 'README.md'), '');

      const result = await listProjectFiles(root);
      expect(result.files.sort()).toEqual(['README.md', 'src/shared/api.ts']);
      // Пути от корня, разделитель — прямой слэш: так их пишут в AGENTS.md.
      expect(result.dirs.sort()).toEqual(['src', 'src/shared', 'tests']);
      expect(result.dirCount).toBe(3);
      // Маленькое дерево обойдено целиком: списки полные, флага нет.
      expect(result.truncated).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('упёрся в потолок — говорит об этом флагом', async () => {
    // Поднимать потолок нельзя: стоимость обхода платится на каждой сборке
    // промпта. Но и сверять ссылки по обрезанному списку нельзя — нужен
    // явный сигнал, иначе существующий путь объявляется битым.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-scan-cap-'));
    try {
      for (let d = 0; d < 20; d++) {
        const dir = path.join(root, `d${String(d).padStart(2, '0')}`);
        fs.mkdirSync(dir);
        for (let f = 0; f < 1000; f++) fs.writeFileSync(path.join(dir, `f${f}.ts`), '');
      }
      fs.mkdirSync(path.join(root, 'zzz-last'));

      const result = await listProjectFiles(root);
      expect(result.files).toHaveLength(20000);
      // Каталог в конце обхода не попал — ровно поэтому нужен флаг.
      expect(result.dirs).not.toContain('zzz-last');
      expect(result.truncated).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
