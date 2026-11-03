import { describe, expect, it } from 'vitest';
import { mergeTasks, tasksFromScripts, tasksFromTasksJson } from '../src/shared/tasks-json';

/**
 * Задачи чужого репозитория. Проверяем на том, что реально встречается:
 * комментарии, `${workspaceFolder}`, `type: npm`, композитные задачи без команды.
 */
describe('tasksFromTasksJson', () => {
  it('простая задача с аргументами', () => {
    const text = JSON.stringify({ tasks: [{ label: 'build', command: 'npm', args: ['run', 'build'] }] });
    expect(tasksFromTasksJson(text)).toEqual([{ label: 'build', command: 'npm run build', source: 'tasks-json' }]);
  });

  it('комментарии и висячие запятые не ломают разбор', () => {
    const text = '{\n // сборка\n "tasks": [\n /* основная */\n { "label": "dev", "command": "vite", },\n ],\n}';
    expect(tasksFromTasksJson(text)).toEqual([{ label: 'dev', command: 'vite', source: 'tasks-json' }]);
  });

  it('${workspaceFolder} вырезается, а не остаётся в команде', () => {
    const text = JSON.stringify({
      tasks: [{ label: 'go', command: 'go', args: ['build', '-o', '${workspaceFolder}/bin/app', './...'] }],
    });
    expect(tasksFromTasksJson(text)[0]?.command).toBe('go build -o /bin/app ./...');
  });

  it('type npm — это запуск скрипта, а не программы', () => {
    const text = JSON.stringify({ tasks: [{ label: 'test', type: 'npm', command: 'test:unit' }] });
    expect(tasksFromTasksJson(text)[0]?.command).toBe('npm run test:unit');
  });

  it('тип process даёт ту же строку, что shell', () => {
    const text = JSON.stringify({ tasks: [{ label: 'p', type: 'process', command: 'cargo', args: ['build'] }] });
    expect(tasksFromTasksJson(text)[0]?.command).toBe('cargo build');
  });

  it('аргумент с пробелом берётся в кавычки', () => {
    const text = JSON.stringify({ tasks: [{ label: 'cp', command: 'cp', args: ['a b', 'c'] }] });
    expect(tasksFromTasksJson(text)[0]?.command).toBe("cp 'a b' c");
  });

  it('задача без command пропускается: панель ведёт команду, а не граф', () => {
    const text = JSON.stringify({
      tasks: [
        { label: 'all', dependsOn: ['a'] },
        { label: 'ok', command: 'make' },
      ],
    });
    expect(tasksFromTasksJson(text).map((task) => task.label)).toEqual(['ok']);
  });

  it('без label подписью становится команда', () => {
    expect(tasksFromTasksJson('{"tasks":[{"command":"make all"}]}')[0]?.label).toBe('make all');
  });

  it('повтор подписи не дублируется', () => {
    const text = JSON.stringify({
      tasks: [
        { label: 'a', command: 'x' },
        { label: 'a', command: 'y' },
      ],
    });
    expect(tasksFromTasksJson(text)).toHaveLength(1);
  });

  it('битый JSON — пусто, а не падение', () => {
    expect(tasksFromTasksJson('{ "tasks": [')).toEqual([]);
    expect(tasksFromTasksJson('null')).toEqual([]);
    expect(tasksFromTasksJson('{"tasks": "нет"}')).toEqual([]);
  });

  it('argv-форма не роняет разбор', () => {
    expect(tasksFromTasksJson('{"tasks":[{"label":"a","command":["npm","run"]}]}')).toEqual([]);
  });

  it('потолок на число задач', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ label: `t${index}`, command: `run ${index}` }));
    expect(tasksFromTasksJson(JSON.stringify({ tasks: many }))).toHaveLength(50);
  });
});

describe('tasksFromScripts', () => {
  it('зовёт скрипт менеджером проекта', () => {
    expect(tasksFromScripts([{ name: 'dev', command: 'vite' }], 'pnpm')).toEqual([
      { label: 'dev', command: 'pnpm run dev', source: 'package-json' },
    ]);
  });

  it('имя с необычными символами берётся в кавычки', () => {
    const [task] = tasksFromScripts([{ name: 'build:all prod', command: '' }], 'npm');
    expect(task?.command).toBe("npm run 'build:all prod'");
  });
});

describe('mergeTasks', () => {
  it('задачи проекта первыми, скрипты без повторов вторыми', () => {
    const declared = [{ label: 'build', command: 'make', source: 'tasks-json' as const }];
    const scripts = [
      { label: 'build', command: 'npm run build', source: 'package-json' as const },
      { label: 'test', command: 'npm run test', source: 'package-json' as const },
    ];
    expect(mergeTasks(declared, scripts).map((task) => [task.label, task.source])).toEqual([
      ['build', 'tasks-json'],
      ['test', 'package-json'],
    ]);
  });
});
