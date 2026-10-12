import { describe, expect, it, vi } from 'vitest';
import {
  availableCommands,
  EDITOR_COMMANDS,
  findEditorCommand,
  keybindingForCommand,
  type EditorCommandContext,
} from '../src/renderer/editor/host/editor-commands';

/** Подставной контекст: считает вызовы, а не делает работу — так видно, ЧТО зовут. */
function fakeContext(extra: Partial<EditorCommandContext> = {}): EditorCommandContext & { calls: string[] } {
  const calls: string[] = [];
  const context: EditorCommandContext & { calls: string[] } = {
    calls,
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    selectAll: () => calls.push('selectAll'),
    openFind: (mode) => calls.push(`find:${mode}`),
    openGoto: () => calls.push('goto'),
    indent: () => calls.push('indent'),
    outdent: () => calls.push('outdent'),
    toggleComment: () => calls.push('toggleComment'),
    moveLines: (direction) => calls.push(`moveLines:${direction}`),
    copyLinesDown: () => calls.push('copyLinesDown'),
    ...extra,
  };
  return context;
}

describe('каталог команд редактора', () => {
  it('идентификаторы уникальны и с приставкой редактора', () => {
    const ids = EDITOR_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('editor.')).toBe(true);
  });

  it('у каждой команды есть подпись, синоним и обработчик', () => {
    for (const command of EDITOR_COMMANDS) {
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.alias.length).toBeGreaterThan(0);
      expect(typeof command.run).toBe('function');
    }
  });

  it('команда по идентификатору находится, неизвестная — нет', () => {
    expect(findEditorCommand('editor.undo')?.label).toBe('Отменить');
    expect(findEditorCommand('editor.нетакой')).toBeUndefined();
  });

  it('сочетание клавиш отдаётся для справки', () => {
    expect(keybindingForCommand('editor.find')).toBe('Ctrl+F');
    expect(keybindingForCommand('editor.нетакой')).toBeNull();
  });
});

describe('доступность команд по контексту', () => {
  it('без швов необязательные команды не предлагаются', () => {
    const ids = availableCommands(fakeContext()).map((command) => command.id);
    expect(ids).toContain('editor.undo');
    // Правки строк нужны всем и швов не требуют — они в палитре всегда.
    expect(ids).toContain('editor.toggleComment');
    expect(ids).toContain('editor.moveLineUp');
    expect(ids).toContain('editor.moveLineDown');
    expect(ids).toContain('editor.copyLineDown');
    expect(ids).not.toContain('editor.goToDefinition');
    expect(ids).not.toContain('editor.references');
    expect(ids).not.toContain('editor.format');
    expect(ids).not.toContain('editor.nextProblem');
    expect(ids).not.toContain('editor.previousProblem');
    expect(ids).not.toContain('editor.renameSymbol');
  });

  it('шов дан — команда появляется', () => {
    const context = fakeContext({ goToDefinition: () => undefined, formatCode: () => undefined });
    const ids = availableCommands(context).map((command) => command.id);
    expect(ids).toContain('editor.goToDefinition');
    expect(ids).toContain('editor.format');
    // Ссылок нет — эта команда всё ещё недоступна.
    expect(ids).not.toContain('editor.references');
  });

  it('переименование появляется, когда дан шов', () => {
    const ids = availableCommands(fakeContext({ renameSymbol: () => undefined })).map((command) => command.id);
    expect(ids).toContain('editor.renameSymbol');
  });

  it('переход по пометкам появляется, когда дан (хранилище пометок у рабочего места)', () => {
    const ids = availableCommands(fakeContext({ nextProblem: () => undefined, previousProblem: () => undefined })).map(
      (command) => command.id,
    );
    expect(ids).toContain('editor.nextProblem');
    expect(ids).toContain('editor.previousProblem');
  });
});

describe('выполнение команд', () => {
  it('каждая обязательная команда зовёт свой метод контекста', () => {
    const cases: Array<[string, string]> = [
      ['editor.undo', 'undo'],
      ['editor.redo', 'redo'],
      ['editor.selectAll', 'selectAll'],
      ['editor.find', 'find:find'],
      ['editor.replace', 'find:replace'],
      ['editor.gotoLine', 'goto'],
      ['editor.indent', 'indent'],
      ['editor.outdent', 'outdent'],
      ['editor.toggleComment', 'toggleComment'],
      ['editor.moveLineUp', 'moveLines:-1'],
      ['editor.moveLineDown', 'moveLines:1'],
      ['editor.copyLineDown', 'copyLinesDown'],
    ];
    for (const [id, expected] of cases) {
      const context = fakeContext();
      findEditorCommand(id)!.run(context);
      expect(context.calls).toEqual([expected]);
    }
  });

  it('необязательная команда зовёт шов, если он есть', () => {
    const goToDefinition = vi.fn();
    const context = fakeContext({ goToDefinition });
    findEditorCommand('editor.goToDefinition')!.run(context);
    expect(goToDefinition).toHaveBeenCalledOnce();
  });

  it('команды перехода по пометкам зовут свои швы', () => {
    const nextProblem = vi.fn();
    const previousProblem = vi.fn();
    const context = fakeContext({ nextProblem, previousProblem });
    findEditorCommand('editor.nextProblem')!.run(context);
    findEditorCommand('editor.previousProblem')!.run(context);
    expect(nextProblem).toHaveBeenCalledOnce();
    expect(previousProblem).toHaveBeenCalledOnce();
  });

  it('переименование зовёт шов приложения', () => {
    const renameSymbol = vi.fn();
    findEditorCommand('editor.renameSymbol')!.run(fakeContext({ renameSymbol }));
    expect(renameSymbol).toHaveBeenCalledOnce();
  });

  it('необязательная команда без шва не падает — просто ничего не делает', () => {
    const context = fakeContext();
    expect(() => findEditorCommand('editor.format')!.run(context)).not.toThrow();
    expect(context.calls).toEqual([]);
  });
});
