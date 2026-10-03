import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { addFact, listFacts, verifyFact, addFailure, findFailures, errorSignature, scanDna, showDna, observeDna } from '../src/memory.mjs';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

test('fact status is derived from file hashes', () => {
  const { ctx, root, write } = fixture();
  const id = addFact(ctx, 'sessions are created in SessionManager', { src: ['src/session.js'], kind: 'test' });
  assert.equal(listFacts(ctx)[0].status, 'verified');
  write('src/session.js', '// changed\n');
  assert.equal(listFacts(ctx)[0].status, 'stale');
  verifyFact(ctx, id);
  assert.equal(listFacts(ctx)[0].status, 'verified');
  unlinkSync(join(root, 'src/session.js'));
  assert.equal(listFacts(ctx)[0].status, 'invalidated');
  const inferred = addFact(ctx, 'maybe', { src: ['src/util.py'], kind: 'inferred' });
  assert.equal(listFacts(ctx).find((f) => f.id === inferred).status, 'likely-valid');
  const none = addFact(ctx, 'no source');
  assert.equal(listFacts(ctx).find((f) => f.id === none).status, 'unknown');
  assert.throws(() => addFact(ctx, 'bad', { src: ['nope.js'] }));
});

test('failure memory matches similar errors and normalises noise', () => {
  const { ctx } = fixture();
  addFailure(ctx, { kind: 'resolved', error: "TypeError: cannot read property 'find' of null at /a/b.js:12", reason: 'repo not injected', solution: 'pass repo' });
  addFailure(ctx, { kind: 'failed', tried: 'mock the session store', reason: 'hides real create', retry_if: 'store injectable' });
  const hit = findFailures(ctx, "TypeError: cannot read property 'find' of null at /other/c.js:99");
  assert.equal(hit[0].f.kind, 'resolved');
  assert.equal(findFailures(ctx, 'completely unrelated words here').length, 0);
  assert.equal(errorSignature('x\nError: boom 0xdeadbeef at /p/q.js:3'), 'error: boom H at P:N');
});

test('DNA needs >=3 observations and >=70% share', () => {
  const { ctx } = fixture();
  observeDna(ctx, 'quotes', 'single', 'a.js'); observeDna(ctx, 'quotes', 'single', 'b.js');
  assert.match(showDna(ctx), /no confirmed/);
  observeDna(ctx, 'quotes', 'single', 'c.js');
  assert.match(showDna(ctx), /quotes: single\s+\(3\/3\)/);
  observeDna(ctx, 'quotes', 'double', 'd.js'); observeDna(ctx, 'quotes', 'double', 'e.js');
  assert.match(showDna(ctx), /no confirmed/);
  assert.match(scanDna(fixture().ctx), /./);
});
