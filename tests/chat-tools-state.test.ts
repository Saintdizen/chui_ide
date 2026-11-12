import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Лента вызовов различает две неудачи: инструмент сломался (`ok: false`) и итог
 * отрицательный (`failed`: упавший тест, ненулевой код). Первая — ошибка, вторая —
 * данные. Значок строки уже был, а сводка группы красила всё под одну: группа без
 * ошибок, но с упавшими тестами, получала просто галочку «готово» — и человек не
 * видел, что тесты не прошли.
 *
 * Сторож читает исходник: значок собирается в DOM, а тесты идут без браузера —
 * проверить это иначе, чем по коду, нечем.
 */
const TOOLS = readFileSync(resolve(process.cwd(), 'src/renderer/ui/chat-tools.ts'), 'utf8');
const CHAT_STREAM = readFileSync(resolve(process.cwd(), 'src/renderer/ui/chat-stream.ts'), 'utf8');

describe('состояние группы вызовов', () => {
  it('отрицательный итог отделён от поломки в счёте', () => {
    expect(TOOLS).toContain('if (!result.ok) failed += 1;');
    expect(TOOLS).toContain('else if (result.failed) negative += 1;');
  });

  it('группа без поломок, но с отрицательным итогом — жёлтая галочка', () => {
    expect(TOOLS).toMatch(
      /if \(failed === 0 && negative > 0\) \{\s*state\.className = 'tool-group-state is-ok is-failed';/,
    );
    expect(TOOLS).toContain("svgIcon('checkCircle', 14)");
  });

  it('поломка важнее: красный крест не подменяется', () => {
    expect(TOOLS).toContain("paintToolState(state, 'tool-group-state', failed > 0 ? 'fail' : 'ok');");
  });

  it('в сводке отрицательный итог назван своим словом', () => {
    // Ищем в исходнике подстроку: `$` + `{` — ставим через склейку, чтобы биом
    // не принял строку за случайный шаблон.
    expect(TOOLS).toContain(`с отрицательным итогом: $` + '{negative}');
  });
});

describe('прерванный ход', () => {
  it('строки без результата закрываются словом «прервано», а не спиннером', () => {
    // Отмену узнаёт chat-stream и досылает до карточек: без этого спиннер
    // крутится вечно — хода, который бы принёс результат, больше нет.
    expect(CHAT_STREAM).toContain('tools.abandon();');
    expect(TOOLS).toContain("paintToolState(cardState, 'tool-state', 'cancel');");
    expect(TOOLS).toContain("cancel: 'stop',");
  });

  it('прерванный вызов не считается поломкой инструмента', () => {
    const body = TOOLS.slice(TOOLS.indexOf('cancel: () => {'), TOOLS.indexOf('finish: (result)'));
    expect(body).not.toContain('failed += 1');
  });
});

describe('длинный вывод инструмента', () => {
  it('режется по кнопке, а не вываливается простынёй', () => {
    expect(TOOLS).toContain('RAW_PREVIEW_LINES');
    expect(TOOLS).toContain("class: 'tool-raw-more'");
  });
});

/**
 * Жёлтый в ленте — цвет серьёзности предупреждения, тот же, что у волнистой линии
 * пометки в редакторе. Пока карточка брала `--text_color_warning`, которого в теме
 * нет, запасное значение молча делало значок серым — и «упавший тест» выглядел как
 * «ничего не случилось». Сторож держит связь с ролью, а не с догадкой.
 */
describe('жёлтый цвет отрицательного итога', () => {
  const CSS = readFileSync(resolve(process.cwd(), 'src/renderer/styles/chat.css'), 'utf8');

  for (const selector of ['.tool-state.is-ok.is-failed', '.tool-group-state.is-ok.is-failed']) {
    it(`${selector} берёт цвет серьёзности`, () => {
      const rule = CSS.match(new RegExp(`${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(rule, selector).toContain('var(--severity_warning');
      expect(rule, selector).not.toContain('--text_color_warning');
    });
  }
});
