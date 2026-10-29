import { describe, expect, it } from 'vitest';
import { agentPrompt } from '../src/shared/agent-prompt';

/**
 * Промпт агентного режима — не украшение, а список того, чем агент умеет
 * пользоваться. Совет про инструмент, которого в наборе нет, стоит шага: модель
 * ищет обходной путь вместо работы. Здесь и проверяется: полный набор получает
 * всё, узкий — только про то, что у него есть, а «Авто» получает всё, потому что
 * скрытое в нём подключается вызовом по имени.
 */

describe('промпт агентного режима', () => {
  it('полному набору достаются все советы', () => {
    const text = agentPrompt('full', { confirm: true });
    expect(text).toContain('read_image');
    expect(text).toContain('подтверждает');
  });

  it('набор без терминала и браузера не рассказывает про них', () => {
    const read = agentPrompt('read', { confirm: true });
    expect(read).not.toContain('terminal');
    expect(read).not.toContain('Команда в терминале');
    // Чтение в нём есть — и советы про чтение остаются.
    expect(read).toContain('lsp');
    expect(read).toContain('search');
    // Правок нет: советы про `edit` врут и убраны.
    expect(read).not.toContain('action patch');
  });

  it('совет про терминал отводит от cd и cat', () => {
    // Замер живых прогонов: `terminal` — второе место после `read` по выводу,
    // а главные источники — `cd` (243 вызова) и `cat`/`grep` вместо инструментов.
    const text = agentPrompt('auto', { confirm: true });
    expect(text).toContain('cwd');
    expect(text).toContain('содержимое — read');
  });

  it('минимум не обещает памяти и подзадач', () => {
    const minimal = agentPrompt('minimal', { confirm: true });
    // В «Минимуме» только ядро и ведение работы: поиск есть, правок нет.
    expect(minimal).toContain('search');
    expect(minimal).not.toContain('read_image');
    // `mind` в «Ведении работы» — он остаётся.
    expect(minimal).toContain('mind');
  });

  it('«Авто» получает все советы: скрытое в нём подключается по имени', () => {
    const auto = agentPrompt('auto', { confirm: true });
    expect(auto).toContain('Команда в терминале');
    expect(auto).toBe(agentPrompt('full', { confirm: true }));
  });

  it('при полном доступе не говорим про подтверждения — их нет', () => {
    const text = agentPrompt('full', { confirm: false });
    expect(text).not.toContain('Правки и команды пользователь подтверждает');
    expect(text).toContain('Не выдумывай содержимое файлов');
  });

  it('в режиме плана тоже без советов о подтверждениях', () => {
    expect(agentPrompt('full', { confirm: false })).not.toContain('подтверждает');
  });

  it('совет о скрытом в ростере остаётся в любом наборе', () => {
    // Скрытое в ростере зовётся по имени, но схемы с описанием у него нет: совет
    // в промпте — единственное место, где модель о нём узнаёт. Считать набор без
    // ростера значит выкинуть советы о `lsp`, `checks` и других.
    const text = agentPrompt('read', { confirm: true });
    for (const name of ['lsp', 'checks']) {
      expect(text, `потерян совет про ${name}`).toContain(name);
    }
  });

  it('промпт короче, чем был бы без отбора', () => {
    const read = agentPrompt('read', { confirm: true });
    const full = agentPrompt('full', { confirm: true });
    expect(read.length).toBeLessThan(full.length);
    // Но не пустой: без советов модель теряет и то, что у неё есть.
    expect(read.length).toBeGreaterThan(200);
  });
});
