import { describe, expect, it } from 'vitest';
import {
  RUN_CODE_MAX_CALLS,
  RUN_CODE_MAX_CHARS,
  clampProgramText,
  formatRunCode,
  programModule,
  programProblem,
  runCodeToolAllowed,
  summarizeCalls,
  type RunCodeCall,
  type RunCodeOutcome,
} from '../src/shared/run-code';
import { runtimePermissionArgs } from '../src/main/ai/run-code';

/**
 * `run_code`: что считается допустимой программой и как читается её ответ.
 *
 * Запуск проверяется отдельно (`tests/run-code-run.test.ts`), а здесь — то, что
 * видит модель: правила программы, сводка вызовов и текст ответа. Ошибка тут
 * выглядит как «программа ничего не сделала»: модель получила бы пустоту вместо
 * причины, и следующий её шаг был бы наугад.
 */

const call = (overrides: Partial<RunCodeCall> = {}): RunCodeCall => ({
  name: 'read_file',
  ok: true,
  summary: 'a.ts: 120 строк',
  ms: 12,
  ...overrides,
});

const outcome = (overrides: Partial<RunCodeOutcome> = {}): RunCodeOutcome => ({
  value: '{"files":3}',
  logs: '',
  calls: [call()],
  ms: 1_200,
  timedOut: false,
  truncated: false,
  ...overrides,
});

describe('какая программа годится', () => {
  it('обычное тело функции — годится', () => {
    expect(programProblem('const files = await tools.list_dir({});\nreturn files;')).toBeNull();
  });

  it('пустая программа объясняет, что нужно', () => {
    expect(programProblem('   \n ')).toContain('Программа пустая');
  });

  it('слишком длинная отвергается с числами', () => {
    expect(programProblem('x'.repeat(RUN_CODE_MAX_CHARS + 1))).toContain(String(RUN_CODE_MAX_CHARS));
  });

  it('модуль вместо тела: import и export не нужны', () => {
    expect(programProblem("import fs from 'node:fs';\nreturn 1;")).toContain('тело функции');
    expect(programProblem('export default 1;')).toContain('тело функции');
    // Слово «import» внутри строки — не объявление, программа годится.
    expect(programProblem('const mode = "import";\nreturn mode;')).toBeNull();
    // А динамический импорт встроенного модуля — законная часть программы.
    expect(programProblem("const fs = await import('node:fs');\nreturn fs.readdirSync('.');")).toBeNull();
  });
});

describe('файл программы', () => {
  it('тело заворачивается в функцию с tools и возвращает значение', () => {
    const file = programModule('return 1 + 1;');
    expect(file).toContain('export default async function (tools) {');
    expect(file).toContain('return 1 + 1;');
    // `return` на верхнем уровне модуля был бы синтаксической ошибкой — проверяем,
    // что он оказался внутри функции.
    expect(file.trimEnd().endsWith('}')).toBe(true);
  });
});

describe('что программа может звать', () => {
  it('обычные инструменты — да', () => {
    expect(runCodeToolAllowed('read_file')).toBe(true);
    expect(runCodeToolAllowed('run_terminal')).toBe(true);
    expect(runCodeToolAllowed('apply_patch')).toBe(true);
  });

  it('себя, вопрос человеку и состояние беседы — нет', () => {
    expect(runCodeToolAllowed('run_code')).toBe(false);
    expect(runCodeToolAllowed('ask')).toBe(false);
    expect(runCodeToolAllowed('update_plan')).toBe(false);
    expect(runCodeToolAllowed('update_goal')).toBe(false);
  });

  it('картинка — нет: она уходит модели отдельным сообщением, а у программы его нет', () => {
    expect(runCodeToolAllowed('read_image')).toBe(false);
  });
});

describe('сводка по вызовам', () => {
  it('считает по видам и называет ошибки', () => {
    const calls = [
      call(),
      call(),
      call(),
      call({ name: 'search', summary: 'найдено 2', ok: false }),
      call({ name: 'search', summary: 'найдено 0' }),
    ];
    expect(summarizeCalls(calls)).toBe('5 вызовов: read_file ×3, search ×2, с ошибкой 1');
  });

  it('без вызовов говорит об этом прямо', () => {
    expect(summarizeCalls([])).toBe('без вызовов инструментов');
  });
});

describe('ответ инструмента', () => {
  it('сводка называет вызовы и время', () => {
    const { summary } = formatRunCode(outcome());
    expect(summary).toBe('run_code: 1 вызов: read_file за 1 с');
  });

  it('в разборе есть и вызовы, и результат', () => {
    const { detail } = formatRunCode(outcome());
    expect(detail).toContain('Вызовы программы:');
    expect(detail).toContain('1. read_file — a.ts: 120 строк (12 мс)');
    expect(detail).toContain('Что вернула программа:');
    expect(detail).toContain('{"files":3}');
  });

  it('вывод console показывается отдельным блоком', () => {
    const { detail } = formatRunCode(outcome({ logs: 'файлов: 3' }));
    expect(detail).toContain('Вывод программы (console):');
    expect(detail).toContain('файлов: 3');
  });

  it('ошибка называет причину и стек, а не «что-то пошло не так»', () => {
    const { summary, detail } = formatRunCode(
      outcome({ error: 'files is not iterable', stack: 'at program.mjs:3:5', value: undefined }),
    );
    expect(summary).toBe('run_code: ошибка — files is not iterable');
    expect(detail).toContain('Программа упала: files is not iterable');
    expect(detail).toContain('at program.mjs:3:5');
    expect(detail).toContain('Исправь программу');
  });

  it('предел времени назван остановкой, а не ошибкой программы', () => {
    const { summary, detail } = formatRunCode(outcome({ timedOut: true, value: undefined }));
    expect(summary).toContain('остановлена по времени');
    expect(detail).toContain('не уложилась в отведённое время');
  });

  it('превышенный предел вызовов виден модели', () => {
    const { detail } = formatRunCode(outcome({ callsExceeded: true }));
    expect(detail).toContain('Вызовов больше предела');
  });

  it('обрезка честно названа', () => {
    const { detail } = formatRunCode(outcome({ truncated: true }));
    expect(detail).toContain('не поместилась в потолок');
  });

  it('пустой результат — это «(пусто)», а не пропавшее поле', () => {
    expect(formatRunCode(outcome({ value: '' })).detail).toContain('(пусто)');
    // Программа ничего не вернула — блока результата нет вовсе, но вызовы видны.
    const silent = formatRunCode(outcome({ value: undefined })).detail;
    expect(silent).not.toContain('Что вернула программа');
    expect(silent).toContain('Вызовы программы');
  });
});

describe('потолок текста', () => {
  it('короткий текст не трогаем', () => {
    expect(clampProgramText('коротко', 100)).toEqual({ text: 'коротко', truncated: false });
  });

  it('длинный обрезаем и помечаем многоточием', () => {
    const { text, truncated } = clampProgramText('а'.repeat(50), 10);
    expect(truncated).toBe(true);
    expect(text).toBe(`${'а'.repeat(10)}…`);
  });

  it('обрезка не режет символ пополам', () => {
    const { text } = clampProgramText('🙂🙂🙂', 2);
    expect(text).toBe('🙂🙂…');
    expect(text.includes('\uFFFD')).toBe(false);
  });
});

describe('флаги модели прав Node', () => {
  it('до 23.5 флаг называется --experimental-permission', () => {
    expect(runtimePermissionArgs('22.22.1', { read: ['/p'], write: ['/t'] })).toEqual([
      '--experimental-permission',
      '--allow-fs-read=/p',
      '--allow-fs-write=/t',
    ]);
  });

  it('с 23.5 — короткое имя', () => {
    expect(runtimePermissionArgs('v24.21.0', { read: ['/p'], write: [] })).toEqual([
      '--permission',
      '--allow-fs-read=/p',
    ]);
  });

  it('на каждый путь свой флаг: запятая в Node 22 — это ОДИН путь', () => {
    const args = runtimePermissionArgs('24.0.0', { read: ['/a', '/b'], write: ['/c'] });
    expect(args).toEqual(['--permission', '--allow-fs-read=/a', '--allow-fs-read=/b', '--allow-fs-write=/c']);
  });

  it('на слишком старом Node прав нет — и флагов тоже', () => {
    expect(runtimePermissionArgs('18.20.0', { read: ['/p'], write: ['/t'] })).toEqual([]);
  });
});

describe('предел вызовов', () => {
  it('число названо в одном месте', () => {
    expect(RUN_CODE_MAX_CALLS).toBe(80);
  });
});
