/**
 * Подмодули git: разбор `git submodule status`.
 *
 * Подмодуль — отдельный репозиторий внутри нашего, закреплённый на конкретном коммите.
 * Для дерева важно одно: какие папки — подмодули и в каком они состоянии (забран ли
 * код, совпадает ли коммит с закреплённым). Это и разбираем здесь — чистая работа с
 * текстом, её видно в тестах без git.
 *
 * Формат строки: первый символ — состояние, затем хеш, путь и (иногда) описание
 * в скобках. Первый символ:
 *   ` ` — подмодуль на месте и на нужном коммите;
 *   `+` — на месте, но коммит ДРУГОЙ (в подмодуле свои изменения или иной checkout);
 *   `-` — не забран: папка пуста, код нужно подтянуть (`submodule update --init`);
 *   `U` — конфликт слияния в подмодуле.
 */

/** Состояние подмодуля в рабочем дереве. */
export type SubmoduleState = 'ok' | 'modified' | 'missing' | 'conflict';

export interface GitSubmodule {
  /** Путь от корня репозитория. */
  path: string;
  /** Коммит, на который подмодуль закреплён в нашем репозитории. */
  hash: string;
  /** Ветка или описание — то, что git печатает в скобках (может быть пустым). */
  description: string;
  state: SubmoduleState;
}

function stateOf(marker: string): SubmoduleState {
  if (marker === '+') return 'modified';
  if (marker === '-') return 'missing';
  if (marker === 'U') return 'conflict';
  return 'ok';
}

/** Человеческая подпись состояния — для подсказки в дереве. */
export function submoduleStateLabel(state: SubmoduleState): string {
  switch (state) {
    case 'ok':
      return 'подмодуль на месте';
    case 'modified':
      return 'в подмодуле другой коммит или правки';
    case 'missing':
      return 'подмодуль не забран: нужен `git submodule update --init`';
    case 'conflict':
      return 'конфликт в подмодуле';
  }
}

/**
 * Разобрать вывод `git submodule status`. Строки с путями разбираем аккуратно:
 * путь — всё до описания в скобках, а если описания нет — от хеша до конца строки.
 */
export function parseSubmodules(stdout: string): GitSubmodule[] {
  const result: GitSubmodule[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const marker = line[0] ?? ' ';
    const rest = line.slice(1).trim();
    const match = /^([0-9a-f]{4,40})\s+(\S.*?)(?:\s+\(([^)]*)\))?$/.exec(rest);
    if (!match) continue;
    result.push({
      hash: match[1]!,
      path: match[2]!.trim(),
      description: (match[3] ?? '').trim(),
      state: stateOf(marker),
    });
  }
  return result;
}
