#!/usr/bin/env python3
"""Доли классов вызовов `terminal` до и после правки подсказки про cwd/read.

База «до» — прогоны до коммита 5d5f93b (02:39:02 +0300), «после» — позже.
Класс по первой команде: `cd` — смена папки, `read` — cat/sed/awk/head/tail,
`grep` — поиск в терминале, `pipe` — конвейер с фильтром, `other` — прочее.
"""
import glob
import json

CUT = 1792538342000  # 2026-10-21 02:39:02 +0300, коммит 5d5f93b
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


def runs():
    out = []
    for path in glob.glob(TELEMETRY):
        for line in open(path, encoding='utf-8'):
            if not line.strip():
                continue
            run = json.loads(line)
            if run.get('mode') != 'agent':
                continue
            side = 'после' if (run.get('startedAt') or run.get('at') or 0) >= CUT else 'до'
            counts, chars = {}, 0
            for step in run.get('steps') or []:
                for call in step.get('calls') or []:
                    if not isinstance(call, dict) or call.get('name') != 'terminal':
                        continue
                    try:
                        args = json.loads(call.get('args') or '{}')
                    except Exception:
                        continue
                    kind = classify(args.get('command') or '')
                    counts[kind] = counts.get(kind, 0) + 1
                    chars += len(call.get('detail') or '')
            if counts:
                out.append((side, sum(counts.values()), counts, chars))
    return out


def main():
    data = runs()
    for side in ('до', 'после'):
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
