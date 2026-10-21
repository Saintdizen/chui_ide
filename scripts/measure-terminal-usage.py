#!/usr/bin/env python3
"""Доли классов вызовов `terminal` до и после правки подсказки про cwd/read.

Три части: «до» — раньше коммита 5d5f93b (02:39:02 +0300), «перезапуск» — код
уже с правкой, но приложение ещё старое, «после» — приложение перезапущено
(03:23:00 +0300). В замер идёт только «после».
Класс по первой команде: `cd` — смена папки, `read` — cat/sed/awk/head/tail,
`grep` — поиск в терминале, `pipe` — конвейер с фильтром, `other` — прочее.
"""
import glob
import json

# Граница одна — перезапуск приложения с кодом правки. Дата коммита (5d5f93b)
# не годится: между коммитом и перезапуском работал ещё старый код, такие прогоны
# собираются в часть `перезапуск` и в замер не идут. Служебные прогоны ассистента
# отсекаются по составу команд (`is_instrument`), а не по времени: правки замера
# идут в той же среде, и время их от работы с проектом не отделяет.
COMMIT_CUT = 1792538342000  # 2026-10-21 02:39:02 +0300, коммит 5d5f93b
CUT = 1792543384000  # 2026-10-21 03:43:04 — перезапуска с кодом правки ещё не было
TELEMETRY = '/home/dethmond/.config/chui-ide/telemetry/runs*.jsonl'
LEADS = {
    'grep': ('grep ', 'rg ', 'rg\t'),
    'read': ('cat ', 'sed -n', 'awk ', 'head ', 'tail '),
}
PIPES = (' | grep', ' | head', ' | tail', ' | awk')


def classify(command):
    c = command.strip()
    if c.startswith(('cd ', 'cd\t')) or c == 'cd':
        return 'cd'
    for kind, prefixes in LEADS.items():
        for p in prefixes:
            if c.startswith(p):
                return kind
    if any(p in c for p in PIPES):
        return 'pipe'
    return 'other'


def classify_lead(command):
    """Класс по ПЕРВОЙ строке: `cd` из тела heredoc — не смена папки.

    Скрипт склеивает команду в одну строку, поэтому `python3 - <<PY … cd foo`
    начинался с `python3`, а `cd … && python3 - <<PY` — с `cd`: по началу
    склейки heredoc уезжал в `cd` или в `other` без разбора.
    """
    plain = ' '.join(command.split())  # склейка: heredoc перестаёт быть первой строкой
    lead = plain.split(' ')[0]
    if lead == 'cd':
        # `cd … && python3 - <<PY` — команда, а не смена папки: скрипт, а не cd.
        return 'other' if ('<<' in command or '\n' in command.strip()) else 'cd'
    return classify(plain)


def is_instrument(run):
    """Прогон самого ассистента, который правил замер, — не работа с проектом.

    Признак — команды в терминале: у такого прогона они идут скриптами
    (`python3 -`, `git add/commit`, `sed -i`), а не `cat`/`grep` по коду. Меряем
    долю инструментов: без неё такой прогон выглядел бы «после» и тянул доли
    в свою сторону.

    Порог мягкий, но составной: под него попадают и мои прежние прогоны, где
    я правил код проекта (00:06, 01:07, 01:27). Это плата за честность выборки:
    761 токен поправок из замера важнее, чем спорить о каждом пограничном прогоне.
    """
    calls, instrument = 0, 0
    for step in run.get('steps') or []:
        for call in step.get('calls') or []:
            if not isinstance(call, dict) or call.get('name') != 'terminal':
                continue
            calls += 1
            try:
                cmd = (json.loads(call.get('args') or '{}').get('command') or '').strip()
            except Exception:
                continue
            lead = cmd.split(' ')[0]
            if lead in ('python3', 'git', 'sed', 'grep', 'npx'):
                instrument += 1
    return calls >= 20 and instrument >= calls * 0.6


def runs():
    out = []
    for path in glob.glob(TELEMETRY):
        for line in open(path, encoding='utf-8'):
            if not line.strip():
                continue
            run = json.loads(line)
            if run.get('mode') != 'agent':
                continue
            started = run.get('startedAt') or run.get('at') or 0
            if started >= CUT:
                side = 'после'
            elif started >= COMMIT_CUT:
                side = 'перезапуск'  # код собран, но приложение ещё старое — в замер не идёт
            else:
                side = 'до'
            if is_instrument(run):
                side = 'ассистент'  # правка самого замера — не в выборку
            counts, chars = {}, 0
            for step in run.get('steps') or []:
                for call in step.get('calls') or []:
                    if not isinstance(call, dict) or call.get('name') != 'terminal':
                        continue
                    try:
                        args = json.loads(call.get('args') or '{}')
                    except Exception:
                        continue
                    kind = classify_lead(args.get('command') or '')
                    counts[kind] = counts.get(kind, 0) + 1
                    chars += len(call.get('detail') or '')
            if counts:
                out.append((side, sum(counts.values()), counts, chars))
    return out


def main():
    data = runs()
    for side in ('до', 'перезапуск', 'после', 'ассистент'):
        mine = [r for r in data if r[0] == side]
        calls = sum(r[1] for r in mine)
        tokens = round(sum(r[3] for r in mine) / 3.5)
        print(f'== {side}: {len(mine)} прогонов, {calls} вызовов, ~{tokens} токенов')
        agg = {}
        for _, _, counts, _ in mine:
            for k, v in counts.items():
                agg[k] = agg.get(k, 0) + v
        for kind, count in sorted(agg.items(), key=lambda kv: -kv[1]):
            print(f'   {kind:6} {count:4} ({100 * count // max(calls, 1):3}%)')
        print()
        for row in sorted(mine, key=lambda r: r[1]):
            total, counts = row[1], row[2]
            parts = ' '.join(f'{k}={v}' for k, v in sorted(counts.items()))
            print(f'   {total:3} вызовов, cd {100 * counts.get("cd", 0) // total:3}%  {parts}')
        print()


if __name__ == '__main__':
    main()
