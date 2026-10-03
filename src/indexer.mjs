// Symbol and dependency indexer. Regex-based on purpose: no native deps, fast, approximate.
// Known limitation: dynamic imports, re-exports and metaprogramming are not resolved.
import { readFileSync } from 'node:fs';
import { join, dirname, extname, posix } from 'node:path';
import { listFiles, sha, statFile, SRC_EXT } from './util.mjs';

const LANG = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'ts', '.tsx': 'ts', '.py': 'py', '.gd': 'gd' };
const JS_KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'await', 'typeof', 'new', 'super', 'import']);
const clip = (s, n = 110) => { const t = s.trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export const isTestPath = (p) => /(^|\/)(tests?|__tests__|spec)\//i.test(p)
  || /\.(test|spec)\.[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$|_test\.py$/.test(p);

function extractJS(text) {
  const lines = text.split('\n'); const syms = []; let cls = null; let clsIndent = -1;
  lines.forEach((ln, i) => {
    const L = i + 1; const ind = ln.match(/^\s*/)[0].length; let m;
    if (cls && ind <= clsIndent && /^\s*}/.test(ln)) cls = null;
    const add = (name, kind, exported, parent = null) => syms.push({ name, kind, line: L, sig: clip(ln), exported: exported ? 1 : 0, parent });
    if ((m = ln.match(/^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) { add(m[4], 'class', m[1]); cls = m[4]; clsIndent = ind; }
    else if ((m = ln.match(/^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/))) add(m[4], 'function', m[1]);
    else if ((m = ln.match(/^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/))) add(m[2], 'function', m[1]);
    else if ((m = ln.match(/^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/))) add(m[2], 'function', m[1]);
    else if ((m = ln.match(/^\s*(export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) add(m[2], 'type', m[1]);
    else if ((m = ln.match(/\b(?:app|router|server|api)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/))) add(`${m[1].toUpperCase()} ${m[2]}`, 'route', true);
    else if (cls && (m = ln.match(/^\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$#][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/)) && !JS_KW.has(m[1])) add(m[1], 'method', false, cls);
  });
  const imports = [];
  for (const m of text.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)['"]([^'"]+)['"]/g)) imports.push(m[1]);
  return { syms, imports };
}

function extractPy(text) {
  const lines = text.split('\n'); const syms = []; let cls = null; let clsIndent = -1;
  lines.forEach((ln, i) => {
    const L = i + 1; if (/^\s*(#|$)/.test(ln)) return;
    const ind = ln.match(/^\s*/)[0].length; let m;
    if (cls && ind <= clsIndent) cls = null;
    if ((m = ln.match(/^\s*class\s+(\w+)/))) { syms.push({ name: m[1], kind: 'class', line: L, sig: clip(ln), exported: 1, parent: null }); cls = m[1]; clsIndent = ind; }
    else if ((m = ln.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/))) syms.push({ name: m[1], kind: cls && ind > clsIndent ? 'method' : 'function', line: L, sig: clip(ln), exported: m[1].startsWith('_') ? 0 : 1, parent: cls && ind > clsIndent ? cls : null });
    else if ((m = ln.match(/^\s*@\w+(?:\.\w+)*\.(get|post|put|delete|patch|route)\(\s*['"]([^'"]+)['"]/))) syms.push({ name: `${m[1].toUpperCase()} ${m[2]}`, kind: 'route', line: L, sig: clip(ln), exported: 1, parent: null });
  });
  const imports = [];
  for (const m of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+/gm)) imports.push(m[1]);
  for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) imports.push(m[1]);
  return { syms, imports };
}

function extractGD(text) {
  const syms = []; const imports = [];
  text.split('\n').forEach((ln, i) => {
    const L = i + 1; let m;
    const add = (name, kind) => syms.push({ name, kind, line: L, sig: clip(ln), exported: 1, parent: null });
    if ((m = ln.match(/^class_name\s+(\w+)/))) add(m[1], 'class');
    else if ((m = ln.match(/^class\s+(\w+)/))) add(m[1], 'class');
    else if ((m = ln.match(/^\s*(?:static\s+)?func\s+(\w+)\s*\(/))) add(m[1], 'function');
    else if ((m = ln.match(/^signal\s+(\w+)/))) add(m[1], 'signal');
  });
  for (const m of text.matchAll(/(?:preload|load)\(\s*"res:\/\/([^"]+)"/g)) imports.push(m[1]);
  return { syms, imports };
}

export function extract(lang, text) {
  if (lang === 'js' || lang === 'ts') return extractJS(text);
  if (lang === 'py') return extractPy(text);
  if (lang === 'gd') return extractGD(text);
  return { syms: [], imports: [] };
}

function resolveImport(lang, from, spec, fileSet) {
  const dir = posix.dirname(from);
  const tryPaths = (base, exts) => {
    for (const e of ['', ...exts]) if (fileSet.has(base + e)) return base + e;
    for (const e of exts) if (fileSet.has(posix.join(base, 'index' + e))) return posix.join(base, 'index' + e);
    return null;
  };
  if (lang === 'js' || lang === 'ts') {
    const exts = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
    let base;
    if (spec.startsWith('.')) base = posix.normalize(posix.join(dir, spec));
    else if (spec.startsWith('@/') || spec.startsWith('~/')) base = posix.join('src', spec.slice(2));
    else return null;
    return tryPaths(base, exts) ?? tryPaths(base.replace(/\.(m|c)?js$/, ''), exts);
  }
  if (lang === 'py') {
    const lead = spec.match(/^\.*/)[0].length; const rest = spec.slice(lead).split('.').filter(Boolean).join('/');
    const bases = [];
    if (lead) { let d = dir; for (let i = 1; i < lead; i++) d = posix.dirname(d); bases.push(posix.join(d, rest)); }
    else { bases.push(rest, posix.join('src', rest), posix.join(dir, rest)); }
    for (const b of bases) { const r = tryPaths(b, ['.py']) ?? (fileSet.has(posix.join(b, '__init__.py')) ? posix.join(b, '__init__.py') : null); if (r) return r; }
    return null;
  }
  if (lang === 'gd') return fileSet.has(spec) ? spec : null;
  return null;
}

export function ensureIndex(db, root, { force = false } = {}) {
  const files = listFiles(root, SRC_EXT);
  const known = new Map(db.prepare('SELECT path,hash,size,mtime FROM files').all().map((r) => [r.path, r]));
  const fileSet = new Set(files);
  let changed = 0; let removed = 0;
  db.exec('BEGIN');
  try {
    for (const p of known.keys()) if (!fileSet.has(p)) {
      for (const t of ['symbols', 'edges']) db.prepare(`DELETE FROM ${t} WHERE ${t === 'symbols' ? 'file' : 'src'}=?`).run(p);
      db.prepare('DELETE FROM refs WHERE src=?').run(p); db.prepare('DELETE FROM files WHERE path=?').run(p); removed++;
    }
    for (const rel of files) {
      const st = statFile(root, rel); if (!st) continue;
      const k = known.get(rel);
      if (!force && k && k.size === st.size && k.mtime === st.mtime) continue;
      const buf = readFileSync(join(root, rel)); const h = sha(buf);
      if (!force && k && k.hash === h) { db.prepare('UPDATE files SET mtime=?,size=? WHERE path=?').run(st.mtime, st.size, rel); continue; }
      const lang = LANG[extname(rel).toLowerCase()];
      const { syms, imports } = extract(lang, buf.toString('utf8'));
      const lineCount = buf.toString('utf8').split('\n').length;
      db.prepare('DELETE FROM symbols WHERE file=?').run(rel); db.prepare('DELETE FROM edges WHERE src=?').run(rel);
      db.prepare('INSERT OR REPLACE INTO files(path,hash,lang,size,mtime,indexed_at,is_test) VALUES(?,?,?,?,?,?,?)')
        .run(rel, h, lang, st.size, st.mtime, Date.now(), isTestPath(rel) ? 1 : 0);
      syms.forEach((s, i) => {
        const end = (syms[i + 1]?.line ?? lineCount + 1) - 1;
        db.prepare('INSERT INTO symbols(file,name,kind,parent,line_start,line_end,sig,exported) VALUES(?,?,?,?,?,?,?,?)')
          .run(rel, s.name, s.kind, s.parent, s.line, Math.max(end, s.line), s.sig, s.exported);
      });
      for (const spec of new Set(imports)) { const dst = resolveImport(lang, rel, spec, fileSet); if (dst && dst !== rel) db.prepare('INSERT OR IGNORE INTO edges(src,dst,kind) VALUES(?,?,?)').run(rel, dst, 'imports'); }
      changed++;
    }
    if (changed || removed) rebuildRefs(db, root, files);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { files: files.length, changed, removed };
}

function rebuildRefs(db, root, files) {
  const byName = new Map();
  for (const s of db.prepare("SELECT id,file,name FROM symbols WHERE kind IN ('function','class','method','type') AND length(name)>=4").all()) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  for (const [n, v] of byName) if (v.length > 5) byName.delete(n); // too ambiguous to be informative
  db.exec('DELETE FROM refs');
  const ins = db.prepare('INSERT OR IGNORE INTO refs(src,symbol_id) VALUES(?,?)');
  for (const rel of files) {
    let text; try { text = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    for (const w of new Set(text.match(/[A-Za-z_$][\w$]{3,}/g) ?? [])) {
      const defs = byName.get(w); if (!defs) continue;
      for (const d of defs) if (d.file !== rel) ins.run(rel, d.id);
    }
  }
}

const RISK_PATH = /(auth|payment|wallet|billing|migration|secret|crypto|security|session|token|permission|admin)/i;
export function fileRisk(db, file) {
  const f = db.prepare('SELECT is_test FROM files WHERE path=?').get(file);
  const importers = db.prepare("SELECT src FROM edges WHERE dst=? AND kind='imports'").all(file).map((r) => r.src);
  const refers = db.prepare('SELECT DISTINCT r.src FROM refs r JOIN symbols s ON s.id=r.symbol_id WHERE s.file=?').all(file).map((r) => r.src);
  const users = new Set([...importers, ...refers]);
  const tests = [...users].filter((u) => isTestPath(u));
  const nsym = db.prepare('SELECT COUNT(*) c FROM symbols WHERE file=?').get(file).c;
  let score = 0; const why = [];
  if (users.size >= 10) { score += 2; why.push(`fan-in ${users.size}`); } else if (users.size >= 4) { score += 1; why.push(`fan-in ${users.size}`); }
  if (RISK_PATH.test(file)) { score += 2; why.push('sensitive path'); }
  if (!f?.is_test && tests.length === 0) { score += 1; why.push('no tests'); }
  if (nsym > 40) { score += 1; why.push(`${nsym} symbols`); }
  return { level: score >= 4 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW', score, why, users: [...users], tests };
}

export function stats(db) {
  const g = (q) => db.prepare(q).get().c;
  return { files: g('SELECT COUNT(*) c FROM files'), symbols: g('SELECT COUNT(*) c FROM symbols'),
    edges: g('SELECT COUNT(*) c FROM edges'), refs: g('SELECT COUNT(*) c FROM refs') };
}
