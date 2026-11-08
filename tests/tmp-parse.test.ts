import { it } from 'vitest';
import { parseCommand } from '../src/main/ai/command-parse';
it('p', () => {
  const cmds = [
    "sh -c 'rm -rf build'",
    'bash -lc "git push --force"',
    'echo $(rm -rf build)',
    'echo `rm -rf build`',
    'eval "rm -rf build"',
    'xargs rm',
    'sudo -u root rm -rf x',
    'FOO=1 nice -n 5 rm x',
    'while read l; do rm "$l"; done',
    'if true; then rm x; fi',
    'for f in *; do rm "$f"; done',
    'cp a b',
    'git status',
    'npm test',
    'rm -rf build',
    'rm $CMD',
  ];
  for (const c of cmds) {
    const p = parseCommand(c);
    console.log(JSON.stringify(c), '→', p.calls.map((x) => x.name).join(','), p.unknown ? 'НЕЯСНО' : 'ясно');
  }
});
