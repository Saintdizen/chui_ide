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
    expect(text).toContain('workflow');
    expect(text).toContain('read_image');
    expect(text).toContain('schedule');
    expect(text).toContain('подтверждает');
  });

  it('набор без терминала и браузера не рассказывает про них', () => {
    const read = agentPrompt('read', { confirm: true });
    expect(read).not.toContain('terminal');
    expect(read).not.toContain('Команда в терминале');
    // Чтение в нём есть — и советы про чтение остаются.
    expect(read).toContain('file_outline');
    expect(read).toContain('search');
    // Правок нет: советы про `edit` врут и убраны.
    expect(read).not.toContain('action patch');
  });

  it('минимум не обещает памяти, подзадач и расписания', () => {
    const minimal = agentPrompt('minimal', { confirm: true });
    // В «Минимуме» только ядро и ведение работы: поиск есть, правок нет.
    expect(minimal).toContain('codebase_search');
    expect(minimal).not.toContain('read_image');
    expect(minimal).not.toContain('run_code');
    // `remember` и `task` в «Ведении работы» — они остаются.
    expect(minimal).toContain('remember');
    expect(minimal).toContain('task');
  });

  it('«Авто» получает все советы: скрытое в нём подключается по имени', () => {
    const auto = agentPrompt('auto', { confirm: true });
    expect(auto).toContain('Команда в терминале');
    expect(auto).toContain('schedule');
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

  it('промпт короче, чем был бы без отбора', () => {
    const read = agentPrompt('read', { confirm: true });
    const full = agentPrompt('full', { confirm: true });
    expect(read.length).toBeLessThan(full.length);
    // Но не пустой: без советов модель теряет и то, что у неё есть.
    expect(read.length).toBeGreaterThan(200);
  });
});
