/**
 * Замер: сворачивает ли `condenseCallArguments` вложенные тела правок.
 *
 * Известный баг 96/смоука: тело `patches[].patches[].newText` в истории
 * выглядело целым. Проверяем оба уровня вложенности и плоскую форму.
 */
const { condenseCallArguments } = require('../dist/shared/context-fit.js');

const body = Array.from({ length: 120 }, (_, i) => `строка ${i + 1}`).join('\n');
const cases = {
  'плоский newText': { oldText: 'a', newText: body },
  'два уровня: patches[].patches[]': { patches: [{ path: 'a.ts', patches: [{ oldText: 'a', newText: body }] }] },
  'edits[].edits[]': { edits: [{ path: 'a.ts', edits: [{ oldText: 'a', newText: body }] }] },
  'одна строка — не сворачиваем': { newText: 'коротко' },
  'не JSON': 'не json',
};

let fails = 0;
for (const [name, args] of Object.entries(cases)) {
  const out = condenseCallArguments(JSON.stringify(args), 200);
  const condensed = out.includes('[свёрнуто:');
  const keptBody = out.includes(body);
  console.log(`${condensed ? 'СВЁРНУТО' : 'ЦЕЛОЕ   '} | ${name} | тело на месте: ${keptBody}`);
}

// Что должно было произойти по замыслу:
const expect = [
  ['плоский newText', true],
  ['два уровня: patches[].patches[]', true],
  ['edits[].edits[]', true],
  ['одна строка — не сворачиваем', false],
  ['не JSON', false],
];
console.log('---');
for (const [name, want] of expect) {
  const out = condenseCallArguments(JSON.stringify(cases[name]), 200);
  const got = out.includes('[свёрнуто:');
  if (got !== want) {
    console.log(`ПРОВАЛ: ${name} — ждали ${want}, получили ${got}`);
    fails++;
  }
}
console.log(fails === 0 ? 'всё сходится' : `провалов: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
