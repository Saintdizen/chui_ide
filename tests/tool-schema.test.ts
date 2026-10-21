import { agentPrompt } from '../src/shared/agent-prompt';
import { AGENT_TOOLS } from '../src/shared/tools';
import { describe, expect, it } from 'vitest';
import { missingArguments, toolSpec, wrongArguments } from '../src/shared/tool-schema';

/**
 * Проверка обязательных полей до исполнения. Поводом была живая ошибка: модель
 * присылала правку по якорю без `path` внутри элемента массива — схема такую форму
 * и разрешала (у массива было описание, но не было полей элемента), а разбор
 * аргументов ждал `path` и отвечал отказом из глубины.
 */

describe('toolSpec', () => {
  it('находит схему по имени', () => {
    expect(toolSpec('read')?.name).toBe('read');
  });

  it('чужое имя (MCP) не находит', () => {
    expect(toolSpec('mcp__foo__bar')).toBeUndefined();
  });
});

describe('missingArguments', () => {
  it('пустые аргументы — все обязательные поля перечислены', () => {
    const spec = toolSpec('search')!;
    expect(missingArguments(spec.inputSchema, {})).toEqual(['query']);
  });

  it('на месте — пустой список', () => {
    const spec = toolSpec('search')!;
    expect(missingArguments(spec.inputSchema, { query: 'x' })).toEqual([]);
  });

  it('null считается пропуском, пустая строка — нет', () => {
    // Пустую строку разбор понимает по-своему (например, «весь файл»), и
    // отвергать её здесь значило бы разойтись с ним.
    const spec = toolSpec('search')!;
    expect(missingArguments(spec.inputSchema, { query: null })).toEqual(['query']);
    expect(missingArguments(spec.inputSchema, { query: '' })).toEqual([]);
  });

  it('вложенный элемент массива называется с индексом', () => {
    // Та самая ошибка: `edits[0].path` — не «path», и по такому ответу видно,
    // какой именно элемент формы забыл поле.
    const spec = toolSpec('edit')!;
    const missing = missingArguments(spec.inputSchema, { edits: [{ edits: [{ newText: 'x' }] }] });
    expect(missing).toEqual(['edits[0].path']);
  });

  it('полная форма правки по якорю проходит', () => {
    const spec = toolSpec('edit')!;
    const args = { edits: [{ path: '/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }] };
    expect(missingArguments(spec.inputSchema, args)).toEqual([]);
  });

  it('вложенный объект в правке тоже проверяется', () => {
    const spec = toolSpec('edit')!;
    const missing = missingArguments(spec.inputSchema, { edits: [{ path: '/a.ts', edits: [{ startLine: 1 }] }] });
    // Обязателен только `newText`: адрес — якорь или четыре позиции, и это
    // проверяет разбор аргументов, который знает про две формы.
    expect(missing).toEqual(['edits[0].edits[0].newText']);
  });

  it('не-объект вместо элемента не роняет проверку', () => {
    const spec = toolSpec('edit')!;
    expect(missingArguments(spec.inputSchema, { edits: [{ path: '/a.ts', edits: ['строка'] }] })).toEqual([]);
  });

  it('подзадача без prompt названа путём внутри tasks', () => {
    // Форма элемента `task.tasks` — в полях схемы, иначе `{ name, prompt }`
    // теряется молча; `description` нарочно не обязателен (разбор подставит сам).
    const spec = toolSpec('task')!;
    expect(missingArguments(spec.inputSchema, { tasks: [{ description: 'без промпта' }] })).toEqual([
      'tasks[0].prompt',
    ]);
  });
});

/**
 * Значения `enum` до исполнения. Повод: `plan` (action steps) — статус шага был свободной строкой,
 * и `closed` вместо `done` уезжало в разбор, который таких значений не знает.
 */
describe('wrongArguments', () => {
  it('значение вне перечня названо вместе с допустимыми', () => {
    const spec = toolSpec('plan')!;
    const args = { action: 'steps', steps: [{ text: 'шаг', status: 'closed' }] };
    expect(wrongArguments(spec.inputSchema, args)).toEqual([
      { path: 'steps[0].status', value: 'closed', allowed: ['pending', 'in_progress', 'done'] },
    ]);
  });

  it('значение из перечня проходит', () => {
    const spec = toolSpec('plan')!;
    const args = { action: 'steps', steps: [{ text: 'шаг', status: 'done' }] };
    expect(wrongArguments(spec.inputSchema, args)).toEqual([]);
  });

  it('чужая форма аргумента не роняет проверку', () => {
    // Элемент массива — строка, а не объект: пусть об этом говорит разбор.
    const spec = toolSpec('edit')!;
    expect(wrongArguments(spec.inputSchema, { edits: ['строка'] })).toEqual([]);
  });
});

/**
 * Описания аргументов — постоянная часть запроса: они едут на каждом шаге прогона.
 * Поэтому у одного и того же аргумента одна и та же формулировка, а то, что верно
 * для всех инструментов сразу («пути абсолютные»), сказано в промпте один раз.
 */
describe('описания аргументов', () => {
  /** Все описания `path`/`paths` из всех схем: имя инструмента → текст. */
  function pathNotes(): Array<{ tool: string; name: string; text: string }> {
    const found: Array<{ tool: string; name: string; text: string }> = [];
    for (const tool of AGENT_TOOLS) {
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        if (name !== 'path' && name !== 'paths') continue;
        const text = (property as { description?: string }).description ?? '';
        found.push({ tool: tool.name, name, text });
      }
    }
    return found;
  }

  /** Допустимые формулировки. Список закрытый: новое слово поймает тест. */
  const CANONICAL = new Set([
    'Path.',
    'PNG, JPEG, WebP, GIF.',
    'Folder.',
    'Path, one file.',
    'File paths.',
    'Current path.',
    'New path.',
    'Narrow to a file; when the name is declared twice.',
    '2-5 files instead; output capped.',
    'references: narrow to a file. definition: the usage. outline: that file.',
    'One file or folder (diagnostics: open files; lint: whole project).',
    'One file (default: all open files).',
    'Folder or file (default: whole project).',
    'diff, log, blame: one file.',
    'One file instead of paths.',
    'One file.',
    'Instead of path: 2-5 files; output capped.',
    'present: result files, 1–5, inside the project.',
    'stage, unstage, discard, commit: files/folders.',
    'Scope; glob from here.',
    'Path mask: ** any depth, * one segment. Without it, all files.',
  ]);

  it('путь описан одинаково везде, где он есть', () => {
    const notes = pathNotes();
    expect(notes.length).toBeGreaterThan(5);
    // Одно и то же описание — одна фраза: список закрытый, синоним — уже новое слово.
    // Основная доля — один и тот же «Path.»; уточнения живут только там, где
    // действительно добавляют смысл (маска, диапазон, «один файл вместо списка»).
    // Путь часто и есть единственный аргумент (read, show): там он зовётся по-своему.
    expect(notes.filter((note) => note.text === 'Path.').length).toBeGreaterThanOrEqual(2);
    for (const note of notes) {
      expect(CANONICAL.has(note.text), `${note.tool}.${note.name}: ${note.text}`).toBe(true);
    }
  });

  it('«Absolute» из схем ушло в промпт', () => {
    // Тринадцать повторов «Absolute path…» стоили дороже одного совета в промпте,
    // и совет к тому же не забывается в ростере, где схемы нет.
    const all = AGENT_TOOLS.flatMap((tool) =>
      Object.values(tool.inputSchema.properties ?? {}).map(
        (property) => (property as { description?: string }).description ?? '',
      ),
    );
    expect(all.filter((text) => /absolute/i.test(text))).toEqual([]);
    expect(agentPrompt('full', { confirm: false })).toContain('абсолютные');
  });
});
