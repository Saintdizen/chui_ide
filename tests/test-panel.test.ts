import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushTopic } from '../src/shared/api';
import { createTestPanel, type TestPanelDeps } from '../src/renderer/ui/test-panel';
import type { CoverageReport } from '../src/shared/python-tests';
import type { TestSuite } from '../src/shared/test-model';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Панель «Тесты» (`renderer/ui/test-panel.ts`).
 *
 * Панель склеивает три источника: дерево тестов из сбора, исходы прогонов и отчёт
 * покрытия. Проверяется именно склейка — разбор вывода и построение дерева живут
 * в `shared/test-model.ts` и проверены отдельно.
 */

function suite(overrides: Partial<TestSuite> = {}): TestSuite {
  return {
    tests: [
      { id: 'test_a', file: 'tests/test_a.py', className: null, name: 'test_one' },
      { id: 'test_a::test_two', file: 'tests/test_a.py', className: null, name: 'test_two' },
      { id: 'test_b', file: 'tests/test_b.py', className: 'TestSum', name: 'test_adds' },
    ],
    total: 3,
    errors: [],
    runner: 'pytest',
    ...overrides,
  };
}

function coverage(): CoverageReport {
  return {
    total: 72.5,
    files: [
      {
        path: 'src/a.py',
        percent: 50,
        statements: 10,
        missing: 5,
        branches: 0,
        branchPartial: 0,
        missingLines: [1, 2],
      },
      { path: 'src/b.py', percent: 95, statements: 20, missing: 1, branches: 0, branchPartial: 0, missingLines: [] },
    ],
  };
}

/**
 * Фейк RPC. Панель подписывается на поток вывода терминала (`onPush`) — обработчик
 * отдаём наружу, чтобы тест мог прислать событие так же, как это делает main.
 */
function fakeRpc(answer: () => Promise<TestSuite>) {
  const push: ((message: unknown) => void)[] = [];
  const request = vi.fn(answer);
  return {
    request,
    stream: async () => ({}) as never,
    onPush: (listener: (message: unknown) => void) => {
      push.push(listener);
      return () => {
        const at = push.indexOf(listener);
        if (at >= 0) push.splice(at, 1);
      };
    },
    emit: (message: unknown) => {
      for (const listener of push) listener(message);
    },
  };
}

function setup(overrides: Partial<TestPanelDeps> = {}) {
  const rpc = fakeRpc(async () => suite());
  const deps: TestPanelDeps = {
    rpc: rpc as unknown as TestPanelDeps['rpc'],
    collect: async () => suite(),
    onRun: () => {},
    isVisible: () => true,
    ...overrides,
  };
  const panel = createTestPanel(deps);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { panel, deps, rpc, settle };
}

describe('панель «Тесты»', () => {
  beforeEach(() => {
    installMiniDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('сбор показывает тесты и их число в сводке', async () => {
    const { panel, settle } = setup();

    await panel.refresh();
    await settle();

    expect(panel.element.querySelectorAll('.tests-node').length).toBeGreaterThan(0);
    expect(panel.element.querySelector('.tests-summary')?.textContent).toContain('3');
  });

  it('тестов нет — так и говорит, а не пустой список', async () => {
    const { panel, settle } = setup({
      collect: async () => suite({ tests: [], total: 0, runner: null }),
    });

    await panel.refresh();
    await settle();

    expect(panel.element.querySelector('.tests-summary')?.textContent).toContain('не найдено');
  });

  it('ошибки сбора видны, а не только в консоли', async () => {
    // Если файл не импортируется, человек должен увидеть это в панели: иначе
    // пропавший из списка тест выглядит как «тестов нет».
    const { panel, settle } = setup({
      collect: async () => suite({ errors: ['tests/broken.py: SyntaxError'] }),
    });

    await panel.refresh();
    await settle();

    expect(panel.element.textContent).toContain('tests/broken.py');
  });

  it('отчёт покрытия заполняет сводку и список файлов', async () => {
    const { panel, settle } = setup();
    await panel.refresh();
    await settle();

    panel.setCoverage(coverage());

    expect(panel.element.textContent).toContain('72.5');
    expect(panel.element.textContent).toContain('src/a.py');
  });
});

describe('панель «Тесты»: покрытие и исходы', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('сброс покрытия убирает его из панели', async () => {
    const { panel, settle } = setup();
    await panel.refresh();
    await settle();

    panel.setCoverage(coverage());
    panel.setCoverage(null);

    expect(panel.element.textContent).not.toContain('src/a.py');
  });

  it('правка постороннего файла не пересобирает список', async () => {
    const collect = vi.fn(async () => suite());
    const { panel, settle } = setup({ collect });
    await panel.refresh();
    await settle();
    const before = collect.mock.calls.length;

    panel.notifyChange('src/renderer/app.ts');
    await settle();

    // Иначе сбор (а он бывает минутами) запускался бы на каждое сохранение.
    expect(collect.mock.calls.length).toBe(before);
  });

  it('правка файла тестов пересобирает список', async () => {
    const collect = vi.fn(async () => suite());
    const { panel, settle } = setup({ collect });
    await panel.refresh();
    await settle();
    const before = collect.mock.calls.length;

    panel.notifyChange('tests/test_a.py');
    // Пересборка не на каждое нажатие: правка копится, сбор запускается через паузу —
    // иначе сохранение большого файла запускало бы сбор двадцать раз подряд.
    await new Promise((resolve) => setTimeout(resolve, 1700));

    expect(collect.mock.calls.length).toBeGreaterThan(before);
  });

  it('ошибка сбора не роняет панель и не выдаёт её за «тестов нет»', async () => {
    // Сборщик может не подняться вовсе (нет раннера, нет Python). Панель обязана
    // остаться на месте; сводку она в этом случае не выдумывает.
    const { panel, settle } = setup({
      collect: async () => Promise.reject(new Error('раннер не найден')),
    });

    await panel.refresh();
    await settle();

    expect(panel.element.querySelector('.tests-summary')?.textContent).toBe('');
    // Панель не пустая: тело на месте и что-то в нём есть.
    expect(panel.element.childNodes.length).toBeGreaterThan(0);
  });
});

describe('панель «Тесты»: прогон и покрытие', () => {
  beforeEach(() => {
    installMiniDom();
  });

  /** Событие потока вывода терминала — так же, как его присылает main. */
  function terminalData(rpc: ReturnType<typeof fakeRpc>, data: string): Promise<void> {
    rpc.emit({ topic: PushTopic.TerminalData, payload: { data } });
    // Подписчик панели вызывается синхронно — дальше отрисовка идёт в микротаске.
    return Promise.resolve();
  }

  it('запуск узла просит прогон с отчётом', async () => {
    const run = vi.fn();
    const { panel, settle } = setup({ onRun: run });
    await panel.refresh();
    await settle();

    const buttons = panel.element.querySelectorAll('.tests-run') as unknown as { click(): void }[];
    expect(buttons.length).toBeGreaterThan(0);
    buttons[0]?.click();

    // Второй аргумент — просьба прислать отчёт: без него раннер не печатает
    // строку покрытия, и подсветка непокрытых строк в редакторе молчит.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toEqual({ report: true });
  });

  it('после запуска узел помечен как «идёт прогон»', async () => {
    const { panel, settle } = setup();
    await panel.refresh();
    await settle();

    const buttons = panel.element.querySelectorAll('.tests-run') as unknown as { click(): void }[];
    buttons[0]?.click();

    expect(panel.element.querySelectorAll('.tests-status.is-running').length).toBeGreaterThan(0);
  });

  it('маркер завершения меняет исход: «идёт» сменяется «прошёл»', async () => {
    const { panel, settle, rpc } = setup();
    await panel.refresh();
    await settle();

    const buttons = panel.element.querySelectorAll('.tests-run') as unknown as { click(): void }[];
    buttons[0]?.click();
    // Маркер итога (см. TEST_RESULT_MARKER в shared/test-model).
    terminalData(rpc, '\nchui-test-result 0\n');
    await settle();

    expect(panel.element.querySelectorAll('.tests-status.is-running')).toHaveLength(0);
    expect(panel.element.querySelectorAll('.tests-status.is-passed').length).toBeGreaterThan(0);
  });

  it('ненулевой код в маркере — упавший тест, а не прошедший', async () => {
    const { panel, settle, rpc } = setup();
    await panel.refresh();
    await settle();

    const buttons = panel.element.querySelectorAll('.tests-run') as unknown as { click(): void }[];
    buttons[0]?.click();
    terminalData(rpc, 'chui-test-result 1');
    await settle();

    expect(panel.element.querySelectorAll('.tests-status.is-failed').length).toBeGreaterThan(0);
    expect(panel.element.querySelectorAll('.tests-status.is-passed')).toHaveLength(0);
  });

  it('прогон с покрытием берёт отчёт из вывода и отдаёт его наружу', async () => {
    const onCoverageReport = vi.fn();
    const onCoverage = vi.fn();
    const { panel, settle, rpc } = setup({ onCoverage, onCoverageReport });
    await panel.refresh();
    await settle();

    panel.setCoverage(null);
    // Кнопка «С покрытием» в панели есть, только если передан `onCoverage`.
    const buttons = panel.element.querySelectorAll('button') as unknown as {
      textContent: string;
      click(): void;
    }[];
    const coverageButton = buttons.find((button) => button.textContent === 'С покрытием');
    expect(coverageButton).toBeDefined();
    coverageButton?.click();
    expect(onCoverage).toHaveBeenCalled();

    terminalData(rpc, 'TOTAL 10 5 50%\nsrc/a.py 10 5 50%\nchui-test-result 0');

    expect(onCoverageReport).toHaveBeenCalled();
    expect(onCoverageReport.mock.calls[0]?.[0].total).toBeCloseTo(50);
  });

  it('исход приходит только для запущенного узла', async () => {
    // Поток терминала общий: вывод посторонней команды не должен красить тесты.
    const { panel, settle, rpc } = setup();
    await panel.refresh();
    await settle();

    terminalData(rpc, 'chui-test-result 0');

    expect(panel.element.querySelector('.tests-status')).toBeNull();
  });
});
