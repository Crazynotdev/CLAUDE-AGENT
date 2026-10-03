import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { ensureIndex, fileRisk, extract } from '../src/indexer.mjs';
import { buildContext, terms } from '../src/ctx.mjs';

test('extracts JS, Python and GDScript symbols', () => {
  const js = extract('js', 'export class A {\n  m(x) { return 1; }\n}\nexport const f = (a) => a;\napp.get("/x", h);\n');
  assert.deepEqual(js.syms.map((s) => `${s.kind}:${s.name}`), ['class:A', 'method:m', 'function:f', 'route:GET /x']);
  const py = extract('py', 'class C:\n    def m(self):\n        pass\n\ndef g():\n    pass\n');
  assert.deepEqual(py.syms.map((s) => `${s.kind}:${s.name}`), ['class:C', 'method:m', 'function:g']);
  const gd = extract('gd', 'class_name Hero\nsignal died\nfunc _ready():\n\tpass\nvar s = preload("res://a/b.gd")\n');
  assert.deepEqual(gd.syms.map((s) => s.name), ['Hero', 'died', '_ready']);
  assert.deepEqual(gd.imports, ['a/b.gd']);
});

test('index resolves imports, refs and is incremental', () => {
  const { ctx, root, write } = fixture();
  const r1 = ensureIndex(ctx.db, root);
  assert.equal(r1.files, 5);
  const e = ctx.db.prepare("SELECT src,dst FROM edges WHERE kind='imports' ORDER BY src").all();
  assert.ok(e.some((x) => x.src === 'src/auth/middleware.js' && x.dst === 'src/auth/service.js'));
  assert.equal(ensureIndex(ctx.db, root).changed, 0);
  write('src/session.js', 'export class SessionManager {\n  create(u) { return u; }\n  destroy() {}\n}\n');
  assert.equal(ensureIndex(ctx.db, root).changed, 1);
  assert.ok(ctx.db.prepare("SELECT 1 FROM symbols WHERE name='destroy'").get());
});

test('ctx ranks relevant symbols, respects budget, lists tests', () => {
  const { ctx, root } = fixture();
  const out = buildContext(ctx, 'authentication login');
  assert.match(out, /AuthService/);
  assert.match(out, /login/);
  assert.match(out, /tests: test\/auth\.test\.js/);
  const tiny = buildContext(ctx, 'authentication login', { budget: 45 });
  assert.ok(tiny.split('\n').length < out.split('\n').length);
  assert.deepEqual(terms('Fix the login bug'), ['login']);
  assert.match(buildContext(ctx, 'zzzunknown'), /no matching symbols/);
});

test('risk reflects fan-in, sensitive paths and missing tests', () => {
  const { ctx, root } = fixture();
  ensureIndex(ctx.db, root);
  const r = fileRisk(ctx.db, 'src/auth/middleware.js');
  assert.ok(r.why.includes('sensitive path') && r.why.includes('no tests'));
  assert.equal(fileRisk(ctx.db, 'src/util.py').level, 'LOW');
});
