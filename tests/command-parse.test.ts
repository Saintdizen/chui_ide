/**
 * Разбор командной строки — основа вопроса «что человеку показывать как опасное».
 *
 * Тесты идут от обходов: каждая строка здесь когда-то прошла бы без вопроса.
 * И обратная сторона не менее важна: лишний вопрос убивает доверие к карточке,
 * поэтому безобидные команды проверяются так же внимательно.
 */
import { describe, expect, it } from 'vitest';
import { parseCommand, programName, unwrapShellLogic } from '../src/main/ai/command-parse';

const names = (command: string): string[] => parseCommand(command).calls.map((call) => call.name);

describe('programName', () => {
  it('снимает каталог, оболочки и ведущий слэш', () => {
    expect(programName('/bin/rm')).toBe('rm');
    expect(programName('./node_modules/.bin/tsc')).toBe('tsc');
    expect(programName('\\rm')).toBe('rm');
    expect(programName('rm')).toBe('rm');
  });

  it('переменная — не имя программы', () => {
    expect(programName('$CMD')).toBe('');
    expect(programName('${CMD}')).toBe('');
  });
});

describe('что запускается', () => {
  it('простые команды и цепочки', () => {
    expect(names('ls -la')).toEqual(['ls']);
    expect(names('npm run build && git commit -m x')).toEqual(['npm', 'git']);
    expect(names('cat a | grep b')).toEqual(['cat', 'grep']);
    expect(names('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('обёртки: глагол — в их аргументах', () => {
    expect(names('sudo -u root rm -rf x')).toEqual(['rm']);
    expect(names('nice -n 5 rm x')).toEqual(['rm']);
    expect(names('xargs rm')).toEqual(['rm']);
    expect(names('FOO=1 env rm x')).toEqual(['rm']);
  });

  it('код внутри шелла разбирается как код', () => {
    expect(names("sh -c 'rm -rf build'")).toContain('rm');
    // Сам шелл тоже в списке: он запускается первым, а `git` — внутри него.
    expect(names('bash -c "git push"')).toEqual(['bash', 'git']);
    // `-lc` — это `-l` и `-c` вместе; строкой после него шелл исполняет.
    expect(names('bash -lc "git push --force"')).toEqual(['bash', 'git']);
    expect(names('eval "rm -rf build"')).toEqual(['eval', 'rm']);
  });

  it('подстановки разбираются: они выполняются раньше команды', () => {
    // В истории оболочек `echo $(rm -rf build)` не отличить от `rm -rf build`.
    expect(names('echo $(rm -rf build)')).toContain('rm');
    expect(names('echo `rm -rf build`')).toContain('rm');
    expect(names('echo "$(rm -rf x)"')).toContain('rm');
    // Вложенность скобок не рвёт захват: `$(cat $(pwd)/l)`
    expect(names('cat $(cat $(pwd)/list)')).toEqual(['cat', 'cat', 'pwd']);
  });

  it('значение переменной не наше — помечаем неясность', () => {
    // `${HOME}` — запуск не в нём, но значение неизвестно.
    expect(parseCommand('ls ${HOME}').unknown).toBe(true);
    // `$(id)` уже разобрана — это просто вызов `id`.
    expect(names('echo $(id)')).toEqual(['echo', 'id']);
  });

  it('обычные аргументы кодом не считаются', () => {
    // `cp /etc/passwd x` — путь, а не команда: это не причина для вопроса.
    expect(names('cp /etc/passwd x')).toEqual(['cp']);
    expect(parseCommand('cp /etc/passwd x').unknown).toBe(false);
  });

  it('пустое и пробелы', () => {
    expect(parseCommand('').calls).toEqual([]);
    expect(parseCommand('   ').calls).toEqual([]);
  });
});

describe('логика шелла видна как список команд', () => {
  it('циклы и условия раскрываются', () => {
    expect(names('while read l; do rm "$l"; done')).toContain('rm');
    expect(names('for f in *; do rm "$f"; done')).toContain('rm');
    expect(names('if test -f x; then rm x; fi')).toContain('rm');
  });

  it('без ключевых слов текст не трогаем', () => {
    const text = 'ls -la src';
    expect(unwrapShellLogic(text)).toBe(text);
  });
});
