import { describe, expect, it } from 'vitest';
import type { SymbolLocation } from '../src/shared/lsp-locations';
import { PeekController } from '../src/renderer/editor/host/peek-controller';
import type { PeekAnchor, PeekPayload, PeekWidget } from '../src/renderer/editor/widgets/peek-widget';

/**
 * Просмотр файлов без открытия (peek из дерева). Виджет — подставной: проверяем связку
 * «пути → чтение → показ», ход по списку, «Открыть» и закрытие, а не разметку копии.
 */
class FakeWidget {
  visible = false;
  readonly shown: PeekPayload[] = [];
  readonly anchors: PeekAnchor[] = [];
  hides = 0;
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  onStep: ((delta: number) => void) | null = null;

  get isVisible(): boolean {
    return this.visible;
  }

  show(payload: PeekPayload, anchor: PeekAnchor): void {
    this.visible = true;
    this.shown.push(payload);
    this.anchors.push(anchor);
  }

  hide(): void {
    this.visible = false;
    this.hides += 1;
  }

  handleKey(): boolean {
    return false;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function make(
  files: Record<string, string | null>,
  options: {
    definition?: (path: string, position: { line: number; column: number }) => Promise<SymbolLocation[]>;
    position?: { path: string | null; line: number; column: number };
  } = {},
) {
  const fake = new FakeWidget();
  const reads: string[] = [];
  const revealed: Array<{ path: string; line: number; column: number }> = [];
  const notices: string[] = [];
  const controller = new PeekController({
    definition: options.definition,
    readText: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
    widget: fake as unknown as PeekWidget,
    anchor: () => ({ left: 1, top: 2, bottom: 3 }),
    label: (target) => target.path.replace('/root/', ''),
    reveal: (target) => revealed.push({ path: target.path, line: target.line, column: target.column }),
    notice: (text) => notices.push(text),
    position: () => options.position ?? { path: null, line: 1, column: 1 },
  });
  return { fake, controller, reads, revealed, notices };
}

describe('peekFiles: просмотр файлов без открытия', () => {
  it('показывает первый файл: заголовок без строки, счётчик и свой якорь', async () => {
    const { fake, controller, reads } = make({ '/root/a.ts': 'const a = 1;\n', '/root/b.ts': 'const b = 2;\n' });

    controller.peekFiles(['/root/a.ts', '/root/b.ts'], { left: 10, top: 20, bottom: 30 });
    await flush();

    expect(fake.visible).toBe(true);
    expect(fake.shown[0]?.title).toBe('a.ts');
    expect(fake.shown[0]?.total).toBe(2);
    expect(fake.shown[0]?.index).toBe(0);
    expect(fake.shown[0]?.text).toContain('const a = 1;');
    // Якорь — от строки дерева, а не от каретки.
    expect(fake.anchors[0]).toEqual({ left: 10, top: 20, bottom: 30 });
    expect(reads).toEqual(['/root/a.ts']);
  });

  it('ход стрелками показывает следующий файл и не уходит за конец', async () => {
    const { fake, controller } = make({ '/root/a.ts': 'a\n', '/root/b.ts': 'b\n' });
    controller.peekFiles(['/root/a.ts', '/root/b.ts']);
    await flush();

    fake.onStep?.(1);
    await flush();
    expect(fake.shown.at(-1)?.title).toBe('b.ts');
    expect(fake.shown.at(-1)?.index).toBe(1);

    const before = fake.shown.length;
    fake.onStep?.(1);
    await flush();
    expect(fake.shown.length).toBe(before);
  });

  it('текст каждого файла читается один раз за показ', async () => {
    const { fake, controller, reads } = make({ '/root/a.ts': 'a\n', '/root/b.ts': 'b\n' });
    controller.peekFiles(['/root/a.ts', '/root/b.ts']);
    await flush();

    fake.onStep?.(1);
    await flush();
    fake.onStep?.(-1);
    await flush();

    expect(reads).toEqual(['/root/a.ts', '/root/b.ts']);
  });

  it('«Открыть» уводит насовсем и закрывает копию', async () => {
    const { fake, controller, revealed } = make({ '/root/a.ts': 'a\n' });
    controller.peekFiles(['/root/a.ts']);
    await flush();

    fake.onOpen?.();

    expect(fake.visible).toBe(false);
    expect(revealed).toEqual([{ path: '/root/a.ts', line: 1, column: 1 }]);
  });

  it('файл не прочитался — говорим об этом и копию не показываем', async () => {
    const { fake, controller, notices } = make({ '/root/a.ts': null });
    controller.peekFiles(['/root/a.ts']);
    await flush();

    expect(fake.visible).toBe(false);
    expect(notices[0]).toContain('a.ts');
  });

  it('пустой список ничего не показывает', async () => {
    const { fake, controller } = make({});
    controller.peekFiles([]);
    await flush();
    expect(fake.shown).toEqual([]);
  });

  it('закрытие по Escape (onClose) прячет копию', async () => {
    const { fake, controller } = make({ '/root/a.ts': 'a\n' });
    controller.peekFiles(['/root/a.ts']);
    await flush();

    fake.onClose?.();
    expect(fake.visible).toBe(false);
  });
});

describe('peekDefinition: прежнее поведение не сломано', () => {
  it('заголовок места содержит строку, а якорь берётся у каретки', async () => {
    const { fake, controller } = make(
      { '/root/d.ts': 'a\nb\n' },
      {
        definition: async () => [{ path: '/root/d.ts', line: 2, column: 1 }],
        position: { path: '/root/main.ts', line: 1, column: 1 },
      },
    );

    controller.peekDefinition();
    await flush();

    expect(fake.shown[0]?.title).toBe('d.ts:2');
    expect(fake.anchors[0]).toEqual({ left: 1, top: 2, bottom: 3 });
  });

  it('без источника мест заглядывание молчит', async () => {
    const { fake, controller, notices } = make({});
    controller.peekDefinition();
    await flush();
    expect(fake.shown).toEqual([]);
    expect(notices).toEqual([]);
  });
});
