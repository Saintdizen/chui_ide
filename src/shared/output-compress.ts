/**
 * Уборка шума в выводе инструментов перед отправкой модели.
 *
 * Один и тот же текст видят двое: человек — в карточке инструмента, модель — в
 * контексте. Человеку полный вывод нужен, модели — нет: прогресс-бары, служебные
 * последовательности терминала, повторы одной и той же строки и простыни пустых
 * строк весят токены, но ничего не сообщают.
 *
 * Содержание остаётся дословно: код, диффы, ошибки компилятора, перечисление
 * файлов. Сворачивать результаты «по возрасту» в проекте уже пробовали и
 * откатили — агент терял прочитанное. Возврат к этой мысли есть, но другой:
 * текст уходит в файл с адресом (`ai/age-results.ts`), а в истории остаётся строка-ссылка.
 * Здесь же трогаем только оформление. Правила чистые и проверяются без
 * Electron.
 */

/**
 * Управляющие последовательности: цвет и вид (`ESC[…m`), движение курсора и
 * очистка строки, заголовок окна (`ESC]…BEL`). Вывод команды приходит с ними как
 * есть — в контексте модели это мусор, а не текст.
 */
const CONTROL_SEQUENCE = /\u001b(?:\[[0-9;?]*[A-Za-z]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

/** Заливка полосы: `#`, `=`, блочные символы `█` и `▌`, символы Брайля у спиннеров. */
const BAR_FILL = String.raw`\s#=+>*.\-_|/\u2580-\u259f\u2800-\u28ff`;

/**
 * Полоса прогресса в рамке, за которой идёт подпись или проценты:
 * `[####>    ] 45%`, `|██████     | 12%`, `[#########] / reify:lodash: 42%`.
 * Что стоит после рамки, неважно — это всё равно счётчик, а не результат.
 */
const PROGRESS_BAR = new RegExp(String.raw`^\s*[\[|][${BAR_FILL}]*[\]|](?:\s.*)?\s\d{1,3}\s*%\s*$`);

/** Полоса прогресса без процентов и подписи: `[####>        ]`, `|██████   |`. */
const PROGRESS_BAR_BARE = new RegExp(String.raw`^\s*[\[|][${BAR_FILL}]*[\]|]\s*$`);

/** Спиннер pip в скобках с процентами: `⸨⠂⠄⡀⠤⠐⠒⸩ 80%`. */
const SPINNER_WITH_PERCENT = /^\s*[\s\u2800-\u28ff\u2e28\u2e29.]+\d{1,3}\s*%\s*$/;

/** Строка целиком из символов Брайля — спиннер без процентов. */
const SPINNER_ONLY = /^[\s\u2800-\u28ff\u2e28\u2e29]+$/;

/** Строка начинается спиннером: `⠼ idealTree`. Так npm рисует ход установки. */
const SPINNER_START = /^\s*[\u2800-\u28ff\u2e28\u2e29]/;

/** Строка из одного и того же знака заливки (`========`), без единого слова. */
const RULE_LINE = /^\s*([-=*#_])\1{4,}\s*$/;

function isNoiseLine(line: string): boolean {
  // Пустая строка — не шум: простыни из них считает отдельное правило.
  if (line.trim() === '') return false;
  if (PROGRESS_BAR.test(line)) return true;
  if (PROGRESS_BAR_BARE.test(line)) return true;
  if (SPINNER_WITH_PERCENT.test(line)) return true;
  if (SPINNER_ONLY.test(line) && /[\u2800-\u28ff]/.test(line)) return true;
  // Спиннер впереди строки — признак живого прогресса, а не данных: в выводе
  // команд символы Брайля появляются только у анимации ожидания.
  if (SPINNER_START.test(line)) return true;
  return RULE_LINE.test(line);
}

/**
 * Подряд идущие одинаковые строки — в одну с пометкой. Две строки подряд ещё
 * читаются как данные (пустая строка в выводе, повтор элемента в списке), три и
 * больше — уже простыня: так выглядит один и тот же warning на каждую посылку.
 * Пустые строки не трогаем: их считает отдельное правило.
 */
function collapseRepeats(lines: readonly string[]): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < lines.length) {
    let last = at;
    while (last + 1 < lines.length && lines[last + 1] === lines[at]) last += 1;
    const times = last - at + 1;
    if (times >= 3 && lines[at]!.trim() !== '') {
      out.push(lines[at]!, `… (такая же строка повторена ещё ${times - 1} раз)`);
    } else {
      for (let index = at; index <= last; index += 1) out.push(lines[index]!);
    }
    at = last + 1;
  }
  return out;
}

/**
 * Сжать вывод инструмента. Возвращает текст без шума; если после уборки не
 * осталось ничего, а исходный текст был, — пометку: пустой вывод модель поймёт
 * как «команда ничего не напечатала», а это не одно и то же.
 */
export function compressToolOutput(text: string): string {
  const lines = text
    // Только парный перевод строки: одиночный `\r` — это перерисовка, её снимаем ниже.
    .replace(/\r\n/g, '\n')
    .replace(CONTROL_SEQUENCE, '')
    // Терминал перерисовывает строку на месте, и до нас доходят все её состояния
    // через `\r`. Видно человеку последнее — его и оставляем.
    .replace(/^.*\r/gm, '')
    .split('\n')
    .filter((line) => !isNoiseLine(line))
    .map((line) => line.replace(/[ \t]+$/, ''));

  // Пустые простыни: два перевода строки — абзац, три и больше — уже воздух.
  const compressed = collapseRepeats(lines)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (compressed === '' && text.trim() !== '') return '(вывод — прогресс и служебные строки)';
  return compressed;
}

/**
 * Строка «этот тест прошёл»: `✓ name 3ms` (vitest, jest), `✔ name (1.2ms)`
 * (node --test), `ok 1 - name` (TAP), `PASSED` (pytest с `-v`).
 */
const PASSED_TEST_LINE = /^\s*(?:[✓✔√]\s|\d+\s*[✓✔√]\s|ok\s+\d+\s+-\s|PASSED\b)/;

/**
 * Строка точек pytest (`-q`): только точки и отметка процента. Если в строке есть
 * `F`, `E` или `s`, это уже не «всё прошло» — такую строку не трогаем.
 */
const PYTEST_DOTS_LINE = /^[.\s]*\.{5,}[.\s]*(?:\[\s*\d{1,3}%\s*\])?$/;

export interface TestOutputSummary {
  text: string;
  /** Сколько отметок о прошедших тестах свёрнуто. */
  hidden: number;
}

/**
 * Свернуть перечисление прошедших тестов в одну строку, оставив упавшие.
 *
 * Вывод зелёного прогона — сотни строк `✓ имя теста 3ms`: модели они не сообщают
 * ничего сверх итогового «4715 passed», но стоят около восьми тысяч токенов на
 * каждый прогон, и платятся целиком — свежий ответ инструмента в кеш промпта не
 * попадает. Итог прогона, упавшие тесты и текст ошибок остаются дословно: это то,
 * ради чего инструмент и звали. Свёрнутое не теряется — полный вывод уходит в
 * файл-копию с адресом.
 *
 * Правила чистые (без Electron и без знания о конкретном раннере) и годятся
 * только для вывода `run_tests`: в произвольном выводе команды строка с `✔`
 * может быть данными.
 */
export function collapsePassedTests(text: string): TestOutputSummary {
  const lines = text.split('\n');
  const out: string[] = [];
  let hidden = 0;
  let at = 0;
  while (at < lines.length) {
    const passed = countPassed(lines[at]!);
    if (passed === 0) {
      out.push(lines[at]!);
      at += 1;
      continue;
    }
    // Подряд идущие «прошло» — одна строка: важно только их число.
    let count = 0;
    while (at < lines.length) {
      const next = countPassed(lines[at]!);
      if (next === 0) break;
      count += next;
      at += 1;
    }
    hidden += count;
    out.push(`… прошло тестов: ${count}`);
  }
  return { text: out.join('\n'), hidden };
}

/** Сколько прошедших тестов отмечает строка; 0 — строка не про это. */
function countPassed(line: string): number {
  if (PYTEST_DOTS_LINE.test(line)) return line.match(/\./g)?.length ?? 0;
  return PASSED_TEST_LINE.test(line) ? 1 : 0;
}

/**
 * Признак прогона тестов по его итоговой строке: `4715 passed`, `# pass 7`,
 * `Tests: 1 passed, 1 total`. Нужен, чтобы сворачивать перечисление прошедших
 * в выводе произвольной команды (`npm test` через `terminal`) только тогда,
 * когда итог рядом и ничего не теряется.
 */
const TEST_SUMMARY_LINE = /\b\d+\s+(?:passed|passing|прошло)\b|#\s*(?:pass|fail)\s+\d+/i;

export function looksLikeTestRun(text: string): boolean {
  return TEST_SUMMARY_LINE.test(text);
}

/** Команды установки пакетов: вывод у них длинный и на треть служебный. */
const INSTALL_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b/;

/** Строки npm/pnpm/yarn/bun, без которых результат установки не прочитать. */
const INSTALL_ERROR =
  /(?:\b(?:ERR_|ERESOLVE|ECONNREFUSED|ETIMEDOUT|EINTEGRITY)|\b(?:error|fatal|failed|invalid|unsupported|warn|notice|deprecated)\b|^YN\d{4}:)/i;

/** Итоговые строки установки: добавлено/изменено/найдено и `up to date`. */
const INSTALL_SUMMARY =
  /^(?:added|removed|changed|updated|audited|found)\b|^up to date\b|packages are looking for funding|^run `npm fund` for details$/i;

function isInstallLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return INSTALL_ERROR.test(trimmed) || INSTALL_SUMMARY.test(trimmed);
}

/**
 * Сжать вывод установки пакетов до результата и ошибок, не теряя их.
 *
 * Полный вывод остаётся у вызывающего (обычно в spill-файле), а модели уходит
 * только то, что влияет на следующее действие: сколько пакетов добавилось,
 * какие предупреждения/ошибки возникли. Возвращает `null`, когда команда не про
 * установку или выход уже и так короткий — тогда сжатие не нужно.
 */
export function summarizeInstall(command: string, text: string): { text: string; hidden: number } | null {
  if (!INSTALL_COMMAND.test(command)) return null;
  const lines = text.split('\n');
  const kept = lines.filter(isInstallLine);
  if (kept.length === 0 || kept.length >= lines.length - 1) return null;
  return { text: kept.join('\n'), hidden: lines.length - kept.length };
}
