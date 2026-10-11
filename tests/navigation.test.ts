import { describe, expect, it, vi } from 'vitest';
import {
  navigationTarget,
  registerNavigation,
  targetPosition,
  type NavigationDeps,
  type NavigationHost,
  type NavigationResource,
} from '../src/renderer/core/navigation';

describe('navigationTarget', () => {
  it('файл внутри проекта — путь, по которому его открываем', () => {
    expect(navigationTarget('file:///proj/src/a.ts', '/proj')).toBe('/proj/src/a.ts');
  });

  it('путь с пробелами разворачивается обратно', () => {
    expect(navigationTarget('file:///proj/my%20dir/a.ts', '/proj')).toBe('/proj/my dir/a.ts');
  });

  it('чужая схема — не наш переход', () => {
    expect(navigationTarget('https://example.com/a.ts', '/proj')).toBeNull();
    expect(navigationTarget('untitled:Untitled-1', '/proj')).toBeNull();
  });

  it('за пределы проекта не ходим', () => {
    expect(navigationTarget('file:///other/a.ts', '/proj')).toBeNull();
    // Граница по сегменту, а не по подстроке: «/project» не внутри «/proj».
    expect(navigationTarget('file:///project/a.ts', '/proj')).toBeNull();
  });

  it('без открытого проекта переходить некуда', () => {
    expect(navigationTarget('file:///proj/a.ts', null)).toBeNull();
  });
});

describe('targetPosition', () => {
  it('диапазон определения — берём его начало', () => {
    expect(targetPosition({ startLineNumber: 12, startColumn: 3, endLineNumber: 12, endColumn: 9 })).toEqual({
      line: 12,
      column: 3,
    });
  });

  it('одна позиция ссылки — сама позиция', () => {
    expect(targetPosition({ lineNumber: 4, column: 7 })).toEqual({ line: 4, column: 7 });
  });

  it('место не названо — начало файла', () => {
    expect(targetPosition()).toEqual({ line: 1, column: 1 });
  });
});

/* ── обработчик перехода ────────────────────────────────────────────────── */

/** Хост Monaco: запоминает обработчики, чтобы их можно было позвать вручную. */
function fakeHost(): NavigationHost & {
  editorOpener: (resource: NavigationResource, target?: unknown) => boolean | Promise<boolean>;
  linkOpener: (resource: NavigationResource) => boolean | Promise<boolean>;
} {
  const host = {
    editorOpener: () => false,
    linkOpener: () => false,
    registerEditorOpener(opener: {
      openCodeEditor: (source: unknown, resource: NavigationResource, target?: unknown) => boolean | Promise<boolean>;
    }) {
      host.editorOpener = (resource, target) => opener.openCodeEditor(null, resource, target);
      return { dispose: () => undefined };
    },
    registerLinkOpener(opener: { open: (resource: NavigationResource) => boolean | Promise<boolean> }) {
      host.linkOpener = (resource) => opener.open(resource);
      return { dispose: () => undefined };
    },
  };
  return host;
}

/** Ссылка в терминах Monaco: `Uri` ведёт себя так же — схема и строковый вид. */
function resource(uri: string): NavigationResource {
  return { scheme: uri.slice(0, uri.indexOf(':')), toString: () => uri };
}

function deps(overrides: Partial<NavigationDeps> = {}): NavigationDeps & { opened: string[]; revealed: string[] } {
  const opened: string[] = [];
  const revealed: string[] = [];
  const base = {
    open: async (path: string) => {
      opened.push(path);
    },
    reveal: (path: string, line: number, column: number) => {
      revealed.push(`${path}:${line}:${column}`);
    },
    root: () => '/proj',
    opened,
    revealed,
    ...overrides,
  };
  return base;
}

describe('registerNavigation', () => {
  it('определение в другом файле открывается и курсор встаёт на место', async () => {
    const host = fakeHost();
    const target = deps();
    registerNavigation(host, target);

    const handled = await host.editorOpener(resource('file:///proj/src/a.ts'), {
      startLineNumber: 5,
      startColumn: 2,
      endLineNumber: 5,
      endColumn: 8,
    });

    expect(handled).toBe(true);
    expect(target.revealed).toEqual(['/proj/src/a.ts:5:2']);
  });

  it('ссылка на путь в тексте открывает файл с начала', async () => {
    const host = fakeHost();
    const target = deps();
    registerNavigation(host, target);

    expect(await host.linkOpener(resource('file:///proj/README.md'))).toBe(true);
    expect(target.revealed).toEqual(['/proj/README.md:1:1']);
  });

  it('чужой файл не открываем — поведение Monaco по умолчанию', async () => {
    const host = fakeHost();
    const target = deps();
    registerNavigation(host, target);

    expect(await host.editorOpener(resource('file:///other/a.ts'))).toBe(false);
    expect(target.opened).toEqual([]);
  });

  it('файла нет — не обрабатываем, но и не падаем', async () => {
    const host = fakeHost();
    const target = deps({
      open: vi.fn(async () => {
        throw new Error('нет файла');
      }),
    });
    registerNavigation(host, target);

    expect(await host.editorOpener(resource('file:///proj/gone.ts'))).toBe(false);
    expect(target.revealed).toEqual([]);
  });
});
