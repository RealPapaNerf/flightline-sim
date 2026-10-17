/* The two chat prompts. Run: node test/prompt_test.js

   A prompt that lives in three places drifts in three directions. The text is
   in src/prompts.js; Settings copies it to the clipboard from there, and the
   two docs print it in a fenced block. This checks the docs still match the
   module word for word, and that each prompt still says the things the format
   readers actually depend on — a prompt that has quietly stopped mentioning
   `format` writes files the sim refuses. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PROMPTS = require('../src/prompts.js');
const ACF = require('../src/aircraft.js');
const TUT = require('../src/tutorial.js');

let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };

function blockOf(file) {
  const text = fs.readFileSync(path.join(ROOT, 'docs', file), 'utf8');
  const m = text.match(/^````text\n([\s\S]*?)\n````$/m);
  return m ? m[1] : null;
}

console.log('== the docs print what the sim copies ==');
for (const [file, key] of [['design-an-aircraft-prompt.md', 'aircraft'], ['design-a-tutorial-prompt.md', 'tutorial']]) {
  const inDoc = blockOf(file);
  ok(inDoc !== null, `${file} has a prompt block`);
  if (inDoc === null) continue;
  ok(inDoc === PROMPTS[key], `${file} matches src/prompts.js`,
    inDoc === PROMPTS[key] ? `${inDoc.length} characters` : `doc ${inDoc.length} chars, module ${PROMPTS[key].length} chars`);
}

console.log('\n== each prompt asks for what the reader needs ==');
{
  const p = PROMPTS.aircraft;
  ok(p.includes(`flightline-aircraft/${ACF.FORMAT}`), 'the aircraft prompt names the format version the reader accepts');
  ok(p.includes('"spec"'), 'it asks for the build sheet, not the full definition');
  // every build-sheet field a chat is told about has to be one normSpec knows
  const known = new Set(ACF.SPEC_FIELDS.map((f) => f.k).concat(['kind', 'id', 'name', 'blurb', 'gimbal', 'packTop', 'quadGear']));
  const named = (p.match(/\b(?:[a-z][a-zA-Z]{2,})\b/g) || []).filter((w) => known.has(w));
  ok(named.length > 25, 'it names the build-sheet fields by their real names', `${new Set(named).size} of them`);
  for (const must of ['mass', 'propD', 'cellsS', 'thrustPerMotor', 'wheelbase', 'span', 'staticMargin'])
    ok(p.includes(must), `it still mentions ${must}`);
  ok(/Numbers only/i.test(p), 'it still forbids formulas and expressions in the JSON');
}
{
  const p = PROMPTS.tutorial;
  ok(p.includes(`flightline-tutorial/${TUT.FORMAT}`), 'the tutorial prompt names the format version the reader accepts');
  for (const k of ['zone', 'gate', 'land', 'say']) ok(p.includes(`"${k}"`), `it documents the ${k} task`);
  for (const f of ['facing', 'facingTol', 'speedMax', 'boxR', 'maxAlt', 'par', 'yawDeg', 'spin', 'hold'])
    ok(p.includes(f), `it still mentions ${f}`);
  ok(p.includes(String(TUT.CRASH_COST)), 'it quotes the real cost of a crash', `${TUT.CRASH_COST}`);
  const gold = TUT.MEDALS.find((m) => m[0] === 'gold')[1];
  ok(p.includes(String(gold)), 'it quotes the real gold threshold', `${gold}`);
  ok(/Positive n is out over\s+the field|Do not put a task behind the pilot/.test(p), 'it still says which way round the field is');
}

/* And the thing that actually matters: a file written to the prompt's own
   shape has to read. This is the worked example out of the aircraft prompt
   and a minimal course in the tutorial prompt's shape. */
console.log('\n== a file written to the prompt reads ==');
{
  const r = ACF.read(JSON.stringify({
    format: 'flightline-aircraft/1', version: '1', source: 'the worked example in the prompt',
    spec: { kind: 'quad', id: 'lr7', name: '7" long range', blurb: 'From the prompt.', mass: 1050, propD: 7, propPitch: 3.5, blades: 2, wheelbase: 305, thrustPerMotor: 1733, motorKV: 1300, cellChem: 'liion', cellsS: 6, cellsP: 2, cellmAh: 3000, cellR: 23 },
  }));
  ok(r.ok, 'the aircraft prompt\'s worked example still reads', r.ok ? `${r.def.name}` : r.errors.join('; '));
}
{
  const r = TUT.read(JSON.stringify({
    format: 'flightline-tutorial/1', id: 'from-prompt', name: 'From the prompt', kinds: ['quad'],
    lessons: [{ id: 'one', name: '1 - Hover', blurb: 'A hover.', start: 'pad', boxR: 60, maxAlt: 25, tasks: [
      { kind: 'say', say: 'Ease the throttle up', tip: 'Throttle is altitude.', hold: 2 },
      { kind: 'zone', say: 'Hold it at eye level', tip: 'Small corrections, early.', n: 8, e: 0, up: 1.7, r: 3, band: 1.2, hold: 20, facing: 'away', facingTol: 40, speedMax: 0, par: 35 },
      { kind: 'gate', say: 'Through the gate', n: 40, e: 0, up: 2.5, width: 5, height: 3.5, yawDeg: 90, par: 11 },
      { kind: 'land', say: 'Land on the pad', n: 8, e: 0, r: 2.5, rate: 1.5, par: 25 },
    ] }],
  }));
  ok(r.ok, 'a course in the tutorial prompt\'s shape still reads', r.ok ? `${r.course.lessons[0].tasks.length} tasks, par ${r.course.lessons[0].par} s` : r.errors.join('; '));
  ok(r.ok && !r.warnings.length, 'and nothing in it had to be changed', r.ok ? r.warnings.join('; ') : '');
}

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
