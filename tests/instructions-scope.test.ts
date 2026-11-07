import { describe, expect, it } from 'vitest';
import {
  formatInstructionFile,
  instructionAppliesTo,
  instructionFoldersFor,
  instructionScopeOf,
  normalizeInstructionFolder,
} from '../src/shared/instructions';

/**
 * Правила проекта бывают в подпапках: `src/AGENTS.md` — про `src`, а не про весь
 * проект. Сторож держит три вещи, без которых подпапочные правила вредят:
 * ближайший набор читается последним (иначе корень перебивает уточнение),
 * правило подпапки не действует выше себя, и в промпте у него есть путь —
 * иначе два `AGENTS.md` неразличимы.
 */

describe('правила из подпапок', () => {
  it('путь у правила подпапки виден — иначе его не отличить от корневого', () => {
    const text = 'Здесь только чистые функции без ввода-вывода.';
    expect(formatInstructionFile('AGENTS.md', text, 8000, 'src/core')).toBe(
      `Инструкции из AGENTS.md (действуют в src/core и ниже):\n${text}`,
    );
  });

  it('правило корня идёт без пометки папки', () => {
    const text = 'Не ломай сборку.';
    expect(formatInstructionFile('AGENTS.md', text, 8000, '')).toBe(`Инструкции из AGENTS.md:\n${text}`);
    expect(formatInstructionFile('AGENTS.md', text, 8000)).toBe(`Инструкции из AGENTS.md:\n${text}`);
  });

  it('ближайший набор правил читается последним', () => {
    expect(instructionFoldersFor('src/core/net')).toEqual(['', 'src', 'src/core', 'src/core/net']);
    expect(instructionFoldersFor('')).toEqual(['']);
  });

  it('папка, которой нет на диске, пропускается', () => {
    const real = (dir: string): boolean => dir === '' || dir === 'src/core';
    expect(instructionFoldersFor('src/core', real)).toEqual(['', 'src/core']);
  });

  it('правило подпапки не действует выше себя', () => {
    expect(instructionAppliesTo('src', 'src/app')).toBe(true);
    expect(instructionAppliesTo('src', 'src')).toBe(true);
    expect(instructionAppliesTo('src', 'tests')).toBe(false);
    expect(instructionAppliesTo('src', 'srcs')).toBe(false);
    // Правило корня действует везде.
    expect(instructionAppliesTo('', 'куда/угодно')).toBe(true);
  });

  it('папка рабочего файла считается от корня проекта', () => {
    expect(instructionScopeOf('/p/src/app/main.ts', '/p')).toBe('src/app');
    expect(instructionScopeOf('/p/README.md', '/p')).toBe('');
    // Файл вне корня — это корень, а не мусорный путь с `..`.
    expect(instructionScopeOf('/другое/x.ts', '/p')).toBe('');
    // Слеш на конце корня не ломает сравнение.
    expect(instructionScopeOf('/p/src/a.ts', '/p/')).toBe('src');
  });

  it('папка нормализуется: слэши прямые, края обрезаны', () => {
    expect(normalizeInstructionFolder('/src/app/')).toBe('src/app');
    expect(normalizeInstructionFolder('src\\app')).toBe('src/app');
    expect(normalizeInstructionFolder('./src')).toBe('src');
    expect(normalizeInstructionFolder(undefined)).toBe('');
  });
});
