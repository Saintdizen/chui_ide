import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findSkill,
  formatSkillCatalog,
  normalizeSkillName,
  parseSkillFile,
  skillBody,
  MAX_SKILLS,
  MAX_SKILL_CATALOG_CHARS,
  MAX_SKILL_DESCRIPTION,
  type SkillEntry,
} from '../src/shared/skills';
import { loadSkills, readSkillBody } from '../src/main/ai/skills';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';

/** Временные каталоги теста: навыки читаются с диска, без папок не проверить. */
const made: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Записать файл навыка, создав папки по дороге. */
async function writeFile(dir: string, relative: string, text: string): Promise<void> {
  const file = path.join(dir, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

const entry = (over: Partial<SkillEntry> = {}): SkillEntry => ({
  name: 'release',
  description: 'Как выпускать версию',
  path: '/p/.chui/skills/release/SKILL.md',
  scope: 'workspace',
  ...over,
});

describe('normalizeSkillName', () => {
  it('приводит к нижнему регистру и дефисам', () => {
    expect(normalizeSkillName('Release Notes')).toBe('release-notes');
    expect(normalizeSkillName('  release_notes ')).toBe('release-notes');
    expect(normalizeSkillName('a--b')).toBe('a-b');
    expect(normalizeSkillName('--release--')).toBe('release');
  });

  it('выбрасывает то, чего в имени вызова быть не может', () => {
    expect(normalizeSkillName('Выпуск версии')).toBe('');
    expect(normalizeSkillName('a.b/c')).toBe('abc');
  });
});

describe('parseSkillFile', () => {
  it('берёт имя и описание из шапки, а тело — после неё', () => {
    const text = ['---', 'name: release', 'description: Как выпускать версию', '---', '# Выпуск', 'Шаги…'].join('\n');
    const skill = parseSkillFile(text, { fallbackName: 'папка', path: '/p/SKILL.md', scope: 'workspace' });
    expect(skill).toMatchObject({ name: 'release', description: 'Как выпускать версию', scope: 'workspace' });
    expect(skillBody(text)).toBe('# Выпуск\nШаги…');
  });

  it('без шапки имя берёт из папки, описание — из первого абзаца', () => {
    const text = '# Выпуск\n\nКоммит описательным сообщением, потом тег и публикация.\n\nДальше подробности.';
    const skill = parseSkillFile(text, { fallbackName: 'release', path: '/p/SKILL.md', scope: 'global' });
    // Заголовок не годится в описание: он не говорит, КОГДА навык нужен.
    expect(skill).toMatchObject({
      name: 'release',
      description: 'Коммит описательным сообщением, потом тег и публикация.',
    });
    expect(skill?.scope).toBe('global');
  });

  it('снимает кавычки и лишние пробелы в шапке', () => {
    const text = ['---', 'name: "Release"', "description: '  Как выпускать  '", '---', 'тело'].join('\n');
    const skill = parseSkillFile(text, { fallbackName: 'x', path: '/p/SKILL.md', scope: 'workspace' });
    expect(skill).toMatchObject({ name: 'release', description: 'Как выпускать' });
  });

  it('незакрытая шапка — это обычный текст, а не шапка', () => {
    const text = '---\nname: release\n\nПросто текст с дефисами.';
    const skill = parseSkillFile(text, { fallbackName: 'release', path: '/p/SKILL.md', scope: 'workspace' });
    // Разбор не нашёл второй `---`, поэтому весь файл остался телом, а имя — из папки.
    expect(skill?.name).toBe('release');
    expect(skill?.description).toBe('name: release');
  });

  it('навык без тела не существует', () => {
    const text = ['---', 'name: release', 'description: пусто', '---', '   ', ''].join('\n');
    expect(parseSkillFile(text, { fallbackName: 'release', path: '/p/SKILL.md', scope: 'workspace' })).toBeNull();
  });

  it('имя из кириллицы не годится для вызова — навыка нет', () => {
    const text = ['---', 'name: Выпуск', 'description: Как выпускать', '---', 'тело'].join('\n');
    // fallback тоже кириллический: привести нечего.
    expect(parseSkillFile(text, { fallbackName: 'выпуск', path: '/p/SKILL.md', scope: 'workspace' })).toBeNull();
  });

  it('описание обрезается до одной строки каталога', () => {
    const long = 'я'.repeat(MAX_SKILL_DESCRIPTION + 50);
    const text = ['---', 'name: long', `description: ${long}`, '---', 'тело'].join('\n');
    const skill = parseSkillFile(text, { fallbackName: 'long', path: '/p/SKILL.md', scope: 'workspace' });
    expect(skill?.description.length).toBe(MAX_SKILL_DESCRIPTION);
  });
});

describe('findSkill', () => {
  it('ищет по имени без учёта регистра и пробелов', () => {
    const skills = [entry(), entry({ name: 'tests', description: 'Пробы' })];
    expect(findSkill(skills, 'Release')?.name).toBe('release');
    expect(findSkill(skills, ' release notes ')?.name ?? null).toBeNull();
    expect(findSkill(skills, 'tests')?.name).toBe('tests');
  });
});

describe('formatSkillCatalog', () => {
  it('без навыков каталога нет — пустой заголовок только занимает место', () => {
    expect(formatSkillCatalog([])).toBeNull();
  });

  it('каждому навыку одна строка: имя и описание', () => {
    const text = formatSkillCatalog([entry(), entry({ name: 'tests', description: 'Прогон проверок' })]) ?? '';
    expect(text).toContain('- release — Как выпускать версию');
    expect(text).toContain('- tests — Прогон проверок');
    // Тела в каталоге нет: его просят инструментом.
    expect(text).toContain('read_skill');
  });

  it('долгое описание укорачивается: в промпте нужен повод, а не абзац', () => {
    const long = `${'Очень длинное пояснение о навыке. '.repeat(12)}Хвост, который уже не нужен.`;
    const text = formatSkillCatalog([entry({ description: long })]) ?? '';
    expect(text).toContain('- release — Очень длинное пояснение о навыке.');
    expect(text).not.toContain('Хвост');
  });

  it('каталог не разрастается выше потолка, а остаток назван числом', () => {
    // Сорок навыков с полными описаниями — это больше, чем весь агентный промпт.
    const many = Array.from({ length: MAX_SKILLS }, (_, index) =>
      entry({ name: `skill-${index}`, description: `${'подробное описание '.repeat(10)}` }),
    );
    const text = formatSkillCatalog(many) ?? '';
    expect(text.length).toBeLessThan(MAX_SKILL_CATALOG_CHARS + 500);
    // Что не влезло — числом, а не молча: иначе навык «есть, но невидим».
    expect(text).toMatch(/…ещё \d+/);
  });
});

describe('loadSkills', () => {
  it('читает навыки проекта и домашние, проектный важнее при совпадении имён', async () => {
    const root = await tempDir('chui-skills-root-');
    const home = await tempDir('chui-skills-home-');

    await writeFile(
      root,
      '.chui/skills/release/SKILL.md',
      ['---', 'description: Свой порядок', '---', 'свой'].join('\n'),
    );
    // Второй навык — одиночным файлом, имя из имени файла.
    await writeFile(root, '.chui/skills/tests.md', 'Прогонять проверки перед коммитом.');
    // Папка без SKILL.md — не навык: там лежат скрипты навыка, а не он сам.
    await writeFile(root, '.chui/skills/helpers/run.sh', 'echo hi');

    await writeFile(
      home,
      '.chui/skills/release/SKILL.md',
      ['---', 'description: Общий порядок', '---', 'общий'].join('\n'),
    );
    await writeFile(home, '.chui/skills/commits/SKILL.md', 'Коммит описательным сообщением с телом.');

    const skills = await loadSkills(root, home);
    // Сначала свои навыки (они конкретнее), потом общие: внутри каждой группы по алфавиту.
    expect(skills.map((skill) => skill.name)).toEqual(['release', 'tests', 'commits']);
    // Проектный выиграл: он конкретнее общего.
    expect(skills.find((skill) => skill.name === 'release')?.description).toBe('Свой порядок');
    expect(skills.find((skill) => skill.name === 'release')?.scope).toBe('workspace');
    expect(skills.find((skill) => skill.name === 'commits')?.scope).toBe('global');
  });

  it('без открытого проекта читает только домашние', async () => {
    const home = await tempDir('chui-skills-home-');
    await writeFile(home, '.chui/skills/commits/SKILL.md', 'Коммит с телом.');
    const skills = await loadSkills(null, home);
    expect(skills.map((skill) => skill.name)).toEqual(['commits']);
  });

  it('нет каталога навыков — пустой список, а не ошибка', async () => {
    const root = await tempDir('chui-skills-root-');
    const home = await tempDir('chui-skills-home-');
    await expect(loadSkills(root, home)).resolves.toEqual([]);
  });

  it('тело читается по имени, а тело с шапкой отдаётся без шапки', async () => {
    const root = await tempDir('chui-skills-root-');
    const home = await tempDir('chui-skills-home-');
    await writeFile(
      root,
      '.chui/skills/release/SKILL.md',
      ['---', 'description: Выпуск', '---', 'Шаги выпуска'].join('\n'),
    );

    const skills = await loadSkills(root, home);
    const found = await readSkillBody(skills, 'RELEASE');
    expect(found?.body).toBe('Шаги выпуска');
    expect(await readSkillBody(skills, 'nope')).toBeNull();
  });
});

describe('инструмент read_skill', () => {
  const context = (entries: SkillEntry[], bodies: Record<string, string>): ToolContext => ({
    workspace: { rootPath: () => process.cwd() } as unknown as ToolContext['workspace'],
    skills: {
      list: async () => entries,
      read: async (name) => {
        const found = findSkill(entries, name);
        const body = found ? bodies[found.name] : undefined;
        return found && body ? { entry: found, body } : null;
      },
    },
  });

  it('отдаёт модели тело навыка', async () => {
    const outcome = await runTool(
      context([entry()], { release: 'Шаг 1\nШаг 2' }),
      'read_skill',
      JSON.stringify({ name: 'release' }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toBe('Навык release');
    expect(outcome.detail).toBe('Шаг 1\nШаг 2');
  });

  it('на неизвестное имя отвечает списком того, что есть', async () => {
    // Тупик тут дороже ошибки: модель должна поправить вызов за один шаг.
    const outcome = await runTool(
      context([entry(), entry({ name: 'tests', description: 'Пробы' })], { release: 'x', tests: 'y' }),
      'read_skill',
      JSON.stringify({ name: 'deploy' }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('deploy');
    expect(outcome.detail).toContain('release');
    expect(outcome.detail).toContain('tests');
  });

  it('без подключённых навыков отказывает понятно', async () => {
    const outcome = await runTool(
      { workspace: { rootPath: () => process.cwd() } as unknown as ToolContext['workspace'] },
      'read_skill',
      JSON.stringify({ name: 'release' }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('Навыки');
  });
});
