import { describe, expect, it } from 'vitest';
import {
  PROJECT_KINDS,
  isProjectKind,
  projectKindInfo,
  projectNameProblem,
  projectSlug,
} from '../src/shared/project-kinds';
import { starterFiles } from '../src/main/project/scaffold';

/**
 * Страж списка видов проекта и заготовок к нему.
 *
 * Виды живут в одном списке на два процесса (`shared/project-kinds.ts`), а файлы —
 * в `main/project/scaffold.ts`. Разъехаться им нельзя: вид без заготовки в окне
 * выбирается, а создать по нему нечего — человек получит пустую папку вместо проекта.
 * Поэтому здесь и сверка списка с заготовками, и правило имени, которое до main
 * доходит из того же места.
 */

describe('виды проектов', () => {
  it('в списке есть Python, Node.js и пустой проект', () => {
    expect(PROJECT_KINDS.map((item) => item.kind)).toEqual(['python', 'node', 'empty']);
  });

  it('у каждого вида есть подпись и подсказка о файлах', () => {
    for (const item of PROJECT_KINDS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.hint.length).toBeGreaterThan(0);
    }
  });

  it('вид из RPC узнаётся только из списка', () => {
    expect(isProjectKind('python')).toBe(true);
    expect(isProjectKind('node')).toBe(true);
    expect(isProjectKind('ruby')).toBe(false);
    expect(isProjectKind('')).toBe(false);
  });

  it('подпись вида берётся по коду, чужой код даёт первый вид, а не падение', () => {
    expect(projectKindInfo('node').label).toBe('Node.js');
    expect(projectKindInfo('ruby' as 'node').kind).toBe('python');
  });
});

describe('файлы-заготовки', () => {
  it('у каждого вида списка есть заготовка — иначе вид выбирается, а создавать нечего', () => {
    for (const item of PROJECT_KINDS) {
      const files = starterFiles(item.kind, 'demo');
      expect(files.length, `вид ${item.kind} без файлов`).toBeGreaterThan(0);
    }
  });

  it('каждый вид кладёт README с именем проекта и .gitignore', () => {
    for (const item of PROJECT_KINDS) {
      const files = starterFiles(item.kind, 'мой-проект');
      const readme = files.find((file) => file.path === 'README.md');
      expect(readme?.contents).toContain('# мой-проект');
      expect(
        files.some((file) => file.path === '.gitignore'),
        `нет .gitignore у ${item.kind}`,
      ).toBe(true);
    }
  });

  it('Python: точка входа и игнор для кеша и окружения', () => {
    const files = starterFiles('python', 'demo');
    expect(files.map((file) => file.path)).toContain('main.py');
    expect(files.find((file) => file.path === 'main.py')?.contents).toContain('def main()');
    expect(files.find((file) => file.path === '.gitignore')?.contents).toContain('__pycache__/');
    expect(files.find((file) => file.path === '.gitignore')?.contents).toContain('.venv/');
  });

  it('Node.js: package.json, точка входа в src и игнор node_modules', () => {
    const files = starterFiles('node', 'Demo Project');
    const manifest = files.find((file) => file.path === 'package.json');
    expect(manifest).toBeTruthy();
    // Манифест обязан быть разбираемым JSON: его читают и npm, и наш разбор проекта.
    const parsed = JSON.parse(manifest!.contents) as { name: string; scripts: Record<string, string> };
    expect(parsed.name).toBe('demo-project');
    expect(parsed.scripts.start).toContain('src/index.js');
    expect(files.map((file) => file.path)).toContain('src/index.js');
    expect(files.find((file) => file.path === '.gitignore')?.contents).toContain('node_modules/');
  });

  it('путь заготовки — всегда вперёд и без выхода из папки проекта', () => {
    for (const item of PROJECT_KINDS) {
      for (const file of starterFiles(item.kind, 'demo')) {
        expect(file.path).not.toContain('..');
        expect(file.path).not.toContain('\\');
        expect(file.path.startsWith('/')).toBe(false);
      }
    }
  });
});

describe('имя проекта', () => {
  it('обычные имена годятся', () => {
    expect(projectNameProblem('api')).toBeNull();
    expect(projectNameProblem('мой проект 2')).toBeNull();
    expect(projectNameProblem('chui-ide')).toBeNull();
    expect(projectNameProblem('  trimmed  ')).toBeNull();
  });

  it('пустое имя — причина, а не молчаливый отказ', () => {
    expect(projectNameProblem('')).toBe('Укажите имя проекта');
    expect(projectNameProblem('   ')).toBe('Укажите имя проекта');
  });

  it('разделители пути не дают увести папку из выбранного каталога', () => {
    // Имя папки и есть имя проекта: `../api` создал бы папку ВНЕ выбранного каталога.
    expect(projectNameProblem('../api')).toContain('/');
    expect(projectNameProblem('a\\b')).toContain('/');
    expect(projectNameProblem('.')).toBeTruthy();
    expect(projectNameProblem('..')).toBeTruthy();
  });

  it('знаки, недопустимые в имени файла, отвергаются', () => {
    for (const name of ['a:b', 'a*b', 'a?b', 'a|b', 'a<b', 'a>b', 'a"b']) {
      expect(projectNameProblem(name), name).toBeTruthy();
    }
  });

  it('хвостовая точка: Windows такое имя превращает в другое', () => {
    expect(projectNameProblem('api.')).toBeTruthy();
    // Пробел по краям не помеха: имя обрезается, и папка получит «api».
    expect(projectNameProblem('api ')).toBeNull();
  });

  it('зарезервированные имена системы не занять', () => {
    expect(projectNameProblem('CON')).toBeTruthy();
    expect(projectNameProblem('nul')).toBeTruthy();
    expect(projectNameProblem('com3')).toBeTruthy();
    // Похожее, но не зарезервированное имя проходит.
    expect(projectNameProblem('console')).toBeNull();
    expect(projectNameProblem('lpt')).toBeNull();
  });

  it('слишком длинное имя отвергается', () => {
    expect(projectNameProblem('a'.repeat(101))).toBeTruthy();
    expect(projectNameProblem('a'.repeat(100))).toBeNull();
  });
});

describe('имя пакета для package.json', () => {
  it('пробелы и заглавные буквы приводятся к виду npm-имени', () => {
    expect(projectSlug('Demo Project')).toBe('demo-project');
    expect(projectSlug('My_App')).toBe('my_app');
  });

  it('имя из одних неподходящих знаков не оставляет пакет безымянным', () => {
    expect(projectSlug('?!')).toBe('app');
    expect(projectSlug('Привет')).toBe('app');
  });
});
