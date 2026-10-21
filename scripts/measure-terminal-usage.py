#!/usr/bin/env python3
"""Доли классов вызовов `terminal` до и после правки подсказки про cwd/read.

Откуда данные: телеметрия (`telemetry/runs*.jsonl`), а если её нет — файлы бесед
(`chats/*.json`), они пишутся всегда. Телеметрия не создаётся, и замер молча
показывал нули; беседы дают те же вызовы, по одной беседе на прогон.

Три части по времени: «до» — раньше коммита 5d5f93b (02:39:02 +0300),
«перезапуск» — код уже с правкой, но приложение ещё старое, «после» — приложение
перезапущено (03:23:00 +0300). В замер идёт только «после». Приговора нет, пока
прогонов «после» меньше MIN_RUNS: один случай — не замер.
Класс по первой команде: `cd` — смена папки, `read` — cat/sed/awk/head/tail,
`grep` — поиск в терминале, `pipe` — конвейер с фильтром, `other` — прочее.
"""
import glob
import json
import os
from pathlib import Path

# Граница одна — перезапуск приложения с кодом правки. Дата коммита (5d5f93b)
# не годится: между коммитом и перезапуском работал ещё старый код, такие прогоны
# собираются в часть `перезапуск` и в замер не идут. Служебные прогоны ассистента
# отсекаются по составу команд (`is_instrument`), а не по времени: правки замера
# идут в той же среде, и время их от работы с проектом не отделяет.
COMMIT_CUT = 1792538342000  # 2026-10-21 02:39:02 +0300, коммит 5d5f93b
CUT = 1792543384000  # 2026-10-21 03:43:04 — перезапуска с кодом правки ещё не было
MIN_RUNS = 5  # меньше — не выборка
LEADS = {
    'grep': ('grep ', 'rg ', 'rg\t'),
    'read': ('cat ', 'sed -n', 'awk ', 'head ', 'tail '),
}
PIPES = (' | grep', ' | head', ' | tail', ' | awk')
# Семейство терминала целиком: в старых беседах вызов звался `run_terminal`, до
# него — `run_command`. Считаем все: иначе часть «до» даёт нули не потому, что
# терминалом не пользовались, а потому что имя было другое.
TERMINAL_NAMES = frozenset({'terminal', 'run_terminal', 'run_command'})


def config_roots():
    """Где состояние приложения: телеметрия и беседы.

    Каталог берём из окружения, иначе — все профили `~/.config/chui-ide*`, какие
    найдутся: у сборок их несколько. Раньше путь был вписан чужим
    (`/home/dethmond`), и замер молча читал пустоту.
    """
    explicit = os.environ.get('CHUI_CONFIG_HOME')
    if explicit:
        return [Path(explicit)]
    xdg = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    return [Path(p) for p in sorted(glob.glob(str(Path(xdg) / 'chui-ide*'))) if Path(p).is_dir()]


def telemetry_runs(root):
    out = []
    for path in glob.glob(str(root / 'telemetry' / 'runs*.jsonl')):
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            try:
                run = json.loads(line)
            except ValueError:
                continue
            if run.get('mode') == 'agent':
                out.append(run)
    return out


def chat_runs(root):
    """Прогоны из бесед: одна беседа — один прогон.

    В `messages[]` вызовы лежат как `toolCalls[{id, name, arguments}]`, ответ —
    следующей репликой с тем же `toolCallId`. Склеиваем в ту же форму, что даёт
    телеметрия (`steps[].calls[{name, args, detail}]`), чтобы счёт был общий.
    """
    out = []
    for path in glob.glob(str(root / 'chats' / '*.json')):
        if path.endswith('.index.json'):
            continue
        try:
            data = json.load(open(path, encoding='utf-8'))
        except ValueError:
            continue
        for conv in data.get('conversations') or []:
            messages = conv.get('messages') or []
            answers = {m.get('toolCallId'): m.get('content') or '' for m in messages if m.get('role') == 'tool'}
            calls = []
            for message in messages:
                for call in message.get('toolCalls') or []:
                    calls.append({
                        'name': call.get('name'),
                        'args': call.get('arguments'),
                        'detail': answers.get(call.get('id')) or '',
                    })
            if calls:
                out.append({'mode': 'agent', 'startedAt': conv.get('updatedAt') or 0, 'steps': [{'calls': calls}]})
    return out


def is_terminal(call):
    return call.get('name') in TERMINAL_NAMES


def parse_command(call):
    args = call.get('args')
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return ''
    if isinstance(args, dict):
        return str(args.get('command') or '')
    return ''


def classify(command):
    text = command.strip().lstrip('$ ').strip()
    if not text:
        return 'other'
    if text.startswith('cd ') or text == 'cd':
        return 'cd'
    if any(pipe in text for pipe in PIPES):
        return 'pipe'
    for name, leads in LEADS.items():
        if text.startswith(leads):
            return name
    return 'other'


def side_of(started_ms):
    if started_ms >= CUT:
        return 'после'
    if started_ms >= COMMIT_CUT:
        return 'перезапуск'
    return 'до'


def is_instrument(run):
    """Служебный прогон: проверка самого замера, а не работа с проектом.

    Метка — команды по `scripts/`. Такие прогоны собираются отдельной частью и в
    сравнение не идут: писатель замера считается за объект замера иначе.
    """
    commands = [
        parse_command(call)
        for step in run.get('steps') or []
        for call in step.get('calls') or []
        if call.get('name') == 'terminal'
    ]
    if not commands:
        return False
    marked = sum(1 for command in commands if 'scripts/' in command)
    return marked >= max(1, len(commands) // 2)


def collect():
    """Разложить прогоны по частям: до / перезапуск / после / ассистент."""
    buckets = {'до': [], 'перезапуск': [], 'после': [], 'ассистент': []}
    for root in config_roots():
        found = telemetry_runs(root) or chat_runs(root)
        for run in found:
            if is_instrument(run):
                buckets['ассистент'].append(run)
                continue
            buckets[side_of(int(run.get('startedAt') or 0))].append(run)
    return buckets


def summarize(runs):
    calls = 0
    chars = 0
    classes = {}
    for run in runs:
        for step in run.get('steps') or []:
            for call in step.get('calls') or []:
                if not is_terminal(call):
                    continue
                calls += 1
                kind = classify(parse_command(call))
                classes[kind] = classes.get(kind, 0) + 1
                chars += len(str(call.get('detail') or ''))
    return {'runs': len(runs), 'calls': calls, 'tokens': chars // 4, 'classes': classes}


def share(stats):
    if not stats['calls']:
        return 0.0
    return 100.0 * (stats['classes'].get('cd', 0) + stats['classes'].get('read', 0)) / stats['calls']


def describe(stats):
    order = ('cd', 'read', 'grep', 'pipe', 'other')
    return ', '.join(f'{name} {stats["classes"][name]}' for name in order if stats['classes'].get(name))


def main():
    buckets = collect()
    report = {side: summarize(runs) for side, runs in buckets.items()}
    for side in ('до', 'перезапуск', 'после', 'ассистент'):
        stats = report[side]
        print(f"== {side}: {stats['runs']} прогонов, {stats['calls']} вызовов, ~{stats['tokens']} токенов")
        if stats['calls']:
            print(f"   {describe(stats)}")
        if stats['runs']:
            print(f"   вызовов на прогон: {stats['calls'] / stats['runs']:.1f}")
    after = report['после']
    if after['calls'] == 0:
        print('вердикта нет: в части «после» нет ни одного вызова terminal')
        return
    if after['runs'] < MIN_RUNS:
        print(f"вердикта нет: прогонов «после» {after['runs']}, нужно {MIN_RUNS} — один случай не замер")
        return
    was, now = share(report['до']), share(after)
    print(f'вердикт: cd+read — {now:.0f}% против {was:.0f}% в «до» ({now - was:+.0f} п.п.)')


if __name__ == '__main__':
    main()
