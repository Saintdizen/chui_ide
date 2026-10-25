import { execGit } from './exec';

/**
 * Сырой унифицированный diff файла от git. Контекст задаём сами, а не берём из
 * настроек git: инструмент отдаёт текст модели, и у человека в `diff.context`
 * может стоять 25 строк — тогда больше половины отведённого места уйдёт на
 * неизменённый текст (на нашем репозитории такой конфиг раздувает diff в 2,5
 * раза — 769 КБ против 298 КБ). `-U3` — обычная норма, её же ждёт модель, читая
 * хунки, и те же границы блоков видит интерфейс. `--no-color` — цвет в ответе
 * инструмента не нужен; `--no-ext-diff` — иначе `diff.external` подменил бы
 * вывод чужой программой, а нам нужен именно унифицированный diff.
 */
export async function rawDiff(
  relative: string,
  repoRoot: string,
  target: { staged: boolean; commit?: string },
): Promise<string> {
  // Пустая строка — «без ограничения по пути»: так просят весь diff. Маркер `--`
  // обязателен, иначе git примет имя файла за ссылку.
  const scope = relative ? ['--', relative] : [];
  const args = target.commit
    ? ['diff', target.commit, '-U3', '--no-color', '--no-ext-diff', ...scope]
    : target.staged
      ? ['diff', '--cached', '-U3', '--no-color', '--no-ext-diff', ...scope]
      : ['diff', '-U3', '--no-color', '--no-ext-diff', ...scope];
  const result = await execGit(args, repoRoot, { allowFailure: true });
  return result.stdout;
}
