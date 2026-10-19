import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARGUMENTS_TOKEN,
  expandCommandPrompt,
  findCommand,
  normalizeCommandName,
  parseCommandFile,
  parseCommandInvocation,
} from '../src/shared/commands';
import { loadCommands } from '../src/main/ai/commands';

/**
 * Команды проекта: свой `/review` в композере.
 *
 * Проверяем две вещи, от которых зависит, сработает ли команда вообще: файл
 * разбирается в команду (имя, описание, тело) и набранное в поле превращается в
 * текст запроса — с хвостом на месте `$ARGUMENTS`.
 */

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-cmd-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseCommandFile', () => {
  it('читает шапку и тело', () => {
    const command = parseCommandFile(
      ['---', 'description: Проверить дифф', '---', 'Посмотри `git diff` и напиши сообщение.'].join('\n'),
      { fallbackName: 'commit', path: '/p/.chui/commands/commit.md', scope: 'workspace' },
    );

    expect(command).toMatchObject({
      name: 'commit',
      description: 'Проверить дифф',
      prompt: 'Посмотри `git diff` и напиши сообщение.',
      scope: 'workspace',
    });
  });

  it('без шапки берёт описание из первого абзаца', () => {
    const command = parseCommandFile('# Выпуск\n\nПрогони проверки и собери версию.\n\nДальше подробности.', {
      fallbackName: 'release',
      path: '/p/.chui/commands/release.md',
      scope: 'workspace',
    });

    // Заголовок не годится в описание: он не говорит, КОГДА команда нужна.
    expect(command?.description).toBe('Прогони проверки и собери версию.');
    expect(command?.name).toBe('release');
  });

  it('пустое тело — не команда', () => {
    // Такая команда подставила бы в поле пустоту.
    expect(
      parseCommandFile('---\ndescription: пусто\n---\n', {
        fallbackName: 'empty',
        path: '/p/.chui/commands/empty.md',
        scope: 'workspace',
      }),
    ).toBeNull();
  });

  it('пустая шапка не мешает: описание берётся из тела', () => {
    // Шапка есть, но описание в ней не задано — значит дело за первым абзацем.
    const command = parseCommandFile('---\ndescription:   \n---\nСделай что-нибудь', {
      fallbackName: 'plain',
      path: '/p/.chui/commands/plain.md',
      scope: 'workspace',
    });
    expect(command?.description).toBe('Сделай что-нибудь');
  });

  it('тело из одного заголовка — не команда: выбрать её в меню нечем', () => {
    expect(
      parseCommandFile('## Заголовок', {
        fallbackName: 'heading',
        path: '/p/.chui/commands/heading.md',
        scope: 'workspace',
      }),
    ).toBeNull();
  });

  it('имя приводится к виду, который набирается после слэша', () => {
    const command = parseCommandFile('---\nname: Release Notes\n---\nТекст', {
      fallbackName: 'x',
      path: '/p/.chui/commands/x.md',
      scope: 'workspace',
    });
    expect(command?.name).toBe('release-notes');
    expect(normalizeCommandName('Выпуск')).toBe('');
  });
});

describe('parseCommandInvocation', () => {
  it('делит набранное на имя и хвост', () => {
    expect(parseCommandInvocation('/review')).toEqual({ name: 'review', tail: '' });
    expect(parseCommandInvocation('/review только стиль')).toEqual({ name: 'review', tail: 'только стиль' });
    expect(parseCommandInvocation('  /Review  стиль  ')).toEqual({ name: 'review', tail: 'стиль' });
  });

  it('обычный вопрос вызовом команды не считается', () => {
    expect(parseCommandInvocation('посмотри /review')).toBeNull();
    expect(parseCommandInvocation('')).toBeNull();
    expect(parseCommandInvocation('/')).toBeNull();
  });
});

describe('expandCommandPrompt', () => {
  const command = {
    name: 'review',
    description: 'Ревью',
    prompt: `Проверь изменения. ${ARGUMENTS_TOKEN}`,
    path: '/p/.chui/commands/review.md',
    scope: 'workspace' as const,
  };

  it('подставляет хвост на место $ARGUMENTS', () => {
    expect(expandCommandPrompt(command, 'особенно стиль')).toBe('Проверь изменения. особенно стиль');
  });

  it('без хвоста не оставляет пустого места', () => {
    expect(expandCommandPrompt(command)).toBe('Проверь изменения.');
  });

  it('без места в тексте хвост дописывается абзацем', () => {
    // Иначе «/review и ещё стиль» молча теряло бы вторую половину.
    const plain = { ...command, prompt: 'Проверь изменения.' };
    expect(expandCommandPrompt(plain, 'ещё стиль')).toBe('Проверь изменения.\n\nещё стиль');
  });

  it('короткая запись $ARG работает так же', () => {
    const short = { ...command, prompt: 'Проверь: $ARG' };
    expect(expandCommandPrompt(short, 'стиль')).toBe('Проверь: стиль');
  });
});

describe('loadCommands', () => {
  it('берёт команды проекта и общие, проектная выигрывает по имени', async () => {
    const home = tempDir();
    const root = tempDir();
    const own = path.join(root, '.chui', 'commands');
    const shared = path.join(home, '.chui', 'commands');
    fs.mkdirSync(own, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });

    fs.writeFileSync(path.join(own, 'review.md'), 'Проверь проект: $ARGUMENTS');
    fs.writeFileSync(path.join(shared, 'review.md'), 'Общая проверка: $ARGUMENTS');
    fs.writeFileSync(path.join(shared, 'commit.md'), 'Напиши сообщение коммита');
    // Не команда: расширение не то.
    fs.writeFileSync(path.join(own, 'notes.txt'), 'просто заметка');

    const commands = await loadCommands(root, home);

    expect(commands.map((command) => `${command.name}:${command.scope}`)).toEqual([
      'review:workspace',
      'commit:global',
    ]);
    expect(commands[0]?.prompt).toContain('Проверь проект');
  });

  it('без проекта остаются только общие', async () => {
    const home = tempDir();
    const shared = path.join(home, '.chui', 'commands');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'commit.md'), 'Напиши сообщение коммита');

    const commands = await loadCommands(null, home);
    expect(commands.map((command) => command.name)).toEqual(['commit']);
  });

  it('нет каталогов — нет команд, и это не ошибка', async () => {
    expect(await loadCommands(tempDir(), tempDir())).toEqual([]);
  });

  it('findCommand ищет по имени без учёта регистра', async () => {
    const command = parseCommandFile('Текст', {
      fallbackName: 'release',
      path: '/p/.chui/commands/release.md',
      scope: 'workspace' as const,
    });
    expect(findCommand([command!], 'RELEASE')?.name).toBe('release');
    expect(findCommand([command!], 'нет-такой')).toBeNull();
  });
});
