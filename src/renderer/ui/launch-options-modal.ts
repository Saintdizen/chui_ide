import type { DebugLaunchOptions } from '../../shared/api';
import { formatArguments, parseArguments } from '../../shared/args';
import { parseEnvFile } from '../../shared/env-file';
import { h } from './dom';
import { createModal } from './modal';

/**
 * Диалог параметров запуска отладки: аргументы, переменные окружения, рабочий каталог.
 *
 * Одно окно на все три настройки, потому что они нужны вместе: задавать их тремя
 * отдельными командами значило бы каждый раз собирать запуск по кусочкам и не видеть
 * итог целиком. Аргументы принимаются строкой и разбираются как в оболочке, окружение
 * — построчно `КЛЮЧ=значение` (тот же формат, что у `.env`), каталог — путём.
 */
export interface LaunchOptionsModalView {
  element: HTMLElement;
  /** Показать окно с текущими значениями. `onAccept` получает собранные параметры. */
  open(input: {
    options: DebugLaunchOptions;
    onAccept: (options: DebugLaunchOptions) => void;
    /** «Сбросить»: забыть параметры и закрыть. */
    onReset: () => void;
  }): void;
  close(): void;
}

/** Окружение → текст: по строке `КЛЮЧ=значение`, как в `.env`. */
function formatEnv(env: Record<string, string> | undefined): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function createLaunchOptionsModal(): LaunchOptionsModalView {
  const argsInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'например --port 8080 --name "my file.txt"',
  });
  const envInput = h('textarea', {
    class: 'field-input',
    rows: 4,
    spellcheck: 'false',
    placeholder: 'LOG_LEVEL=debug\nAPI_URL=http://localhost:8000',
  });
  const cwdInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'пусто — корень проекта',
  });

  const resetButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Сбросить');
  const runButton = h('button', { class: 'btn btn-primary', type: 'button' }, 'Запустить');

  // Текущий обработчик запуска: у каждого открытия свой (см. `open`).
  let accept: ((options: DebugLaunchOptions) => void) | null = null;
  let reset: (() => void) | null = null;

  const modal = createModal({
    className: 'launch-modal',
    title: 'Параметры запуска',
    headerIcon: 'play',
    footer: h('footer', { class: 'modal-footer' }, resetButton, runButton),
    onClose: () => {
      accept = null;
      reset = null;
    },
  });
  modal.body.append(
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Аргументы командной строки'),
      argsInput,
      h('div', { class: 'field-hint' }, 'Кавычки и экранирование работают как в оболочке.'),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Переменные окружения'),
      envInput,
      h('div', { class: 'field-hint' }, 'По строке `КЛЮЧ=значение`. Значения перекрывают `.env` проекта.'),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Рабочий каталог'),
      cwdInput,
      h('div', { class: 'field-hint' }, 'Откуда запускать программу. Пусто — корень проекта.'),
    ),
  );

  function close(): void {
    modal.close();
  }

  /** Собрать параметры из полей: пустое поле — настройки нет. */
  function collect(): DebugLaunchOptions {
    const args = parseArguments(argsInput.value);
    const env = parseEnvFile(envInput.value);
    const cwd = cwdInput.value.trim();
    const options: DebugLaunchOptions = {};
    if (args.length > 0) options.args = args;
    if (Object.keys(env).length > 0) options.env = env;
    if (cwd) options.cwd = cwd;
    return options;
  }

  function submit(): void {
    const options = collect();
    const handler = accept;
    close();
    handler?.(options);
  }

  runButton.addEventListener('click', () => submit());
  resetButton.addEventListener('click', () => {
    const handler = reset;
    close();
    handler?.();
  });

  return {
    element: modal.element,
    open(input) {
      argsInput.value = formatArguments(input.options.args ?? []);
      envInput.value = formatEnv(input.options.env);
      cwdInput.value = input.options.cwd ?? '';
      accept = input.onAccept;
      reset = input.onReset;

      modal.open(argsInput);
      argsInput.select();
    },
    close,
  };
}
