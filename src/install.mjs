// Installs the runtime, hooks, agents, skills, commands and rule into a project. Idempotent; uninstall removes only unmodified managed files.
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from './util.mjs';
import { saveConfig, DEFAULT_CONFIG } from './db.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
export const VERSION = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
const MARK = '.crazy/runtime/hooks/';
const NODE = 'node --disable-warning=ExperimentalWarning';
const HOOKS = [
  ['SessionStart', 'startup|resume|clear|compact', 'session-start.mjs'],
  ['PreToolUse', 'Read|Bash', 'pre-tool.mjs'],
  ['PostToolUse', 'Bash|Read|Edit|Write|MultiEdit', 'post-tool.mjs'],
  ['PreCompact', null, 'pre-compact.mjs'],
];

function managedFiles() {
  const out = [];
  const ls = (d) => (existsSync(join(PKG, d)) ? readdirSync(join(PKG, d)) : []);
  for (const f of ls('agents')) out.push([`agents/${f}`, `.claude/agents/${f}`]);
  for (const s of ls('skills')) out.push([`skills/${s}/SKILL.md`, `.claude/skills/${s}/SKILL.md`]);
  for (const f of ls('commands')) out.push([`commands/${f}`, `.claude/commands/${f}`]);
  out.push(['rules/core.md', '.claude/rules/crazy-core.md']);
  return out;
}

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

export function install(target, { profile, force = false } = {}) {
  const dir = join(target, '.crazy'); const rt = join(dir, 'runtime');
  const log = [];
  rmSync(rt, { recursive: true, force: true }); mkdirSync(rt, { recursive: true });
  for (const d of ['bin', 'src', 'hooks']) cpSync(join(PKG, d), join(rt, d), { recursive: true });
  writeFileSync(join(rt, 'package.json'), '{"type":"module"}\n');
  const wrapper = join(dir, 'crazy');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${NODE} "$(dirname "$0")/runtime/bin/crazy.mjs" "$@"\n`); chmodSync(wrapper, 0o755);
  if (!existsSync(join(dir, 'config.json'))) saveConfig(dir, { ...DEFAULT_CONFIG, profile: profile ?? 'balanced' });
  else if (profile) saveConfig(dir, { ...readJSON(join(dir, 'config.json'), {}), profile });

  const stateP = join(dir, 'install-state.json');
  const state = readJSON(stateP, { files: {} });
  for (const [from, to] of managedFiles()) {
    const src = readFileSync(join(PKG, from)); const dest = join(target, to);
    if (existsSync(dest)) {
      const cur = sha(readFileSync(dest));
      if (cur !== state.files[to] && cur !== sha(src) && !force) { log.push(`kept (modified by you): ${to}`); continue; }
    }
    mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, src); state.files[to] = sha(src);
  }
  const sp = join(target, '.claude', 'settings.json'); mkdirSync(dirname(sp), { recursive: true });
  const settings = readJSON(sp, {}); settings.hooks ??= {};
  for (const ev of Object.keys(settings.hooks)) settings.hooks[ev] = settings.hooks[ev].filter((g) => !g.hooks?.some((h) => h.command?.includes(MARK)));
  for (const [ev, matcher, file] of HOOKS) {
    const entry = { hooks: [{ type: 'command', command: `${NODE} "$CLAUDE_PROJECT_DIR/${MARK}${file}"` }] };
    if (matcher) entry.matcher = matcher;
    (settings.hooks[ev] ??= []).push(entry);
  }
  for (const ev of Object.keys(settings.hooks)) if (!settings.hooks[ev].length) delete settings.hooks[ev];
  writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
  const gi = join(target, '.gitignore'); const want = ['.crazy/store.db*', '.crazy/raw/', '.crazy/current.json', '.crazy/runtime/', '.crazy/hook-errors.log'];
  const have = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const add = want.filter((w) => !have.split('\n').includes(w));
  if (add.length) writeFileSync(gi, have + (have && !have.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  state.version = VERSION; writeFileSync(stateP, JSON.stringify(state, null, 2) + '\n');
  return log;
}

export function uninstall(target, { purge = false } = {}) {
  const dir = join(target, '.crazy'); const stateP = join(dir, 'install-state.json');
  const state = readJSON(stateP, { files: {} }); const log = [];
  for (const [rel, h] of Object.entries(state.files)) {
    const p = join(target, rel);
    if (!existsSync(p)) continue;
    if (sha(readFileSync(p)) === h) rmSync(p); else log.push(`kept (modified): ${rel}`);
  }
  const sp = join(target, '.claude', 'settings.json');
  if (existsSync(sp)) {
    const s = readJSON(sp, {});
    for (const ev of Object.keys(s.hooks ?? {})) { s.hooks[ev] = s.hooks[ev].filter((g) => !g.hooks?.some((h) => h.command?.includes(MARK))); if (!s.hooks[ev].length) delete s.hooks[ev]; }
    if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
    writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
  }
  rmSync(join(dir, 'runtime'), { recursive: true, force: true }); rmSync(join(dir, 'crazy'), { force: true }); rmSync(stateP, { force: true });
  if (purge) rmSync(dir, { recursive: true, force: true }); else log.push('kept .crazy/ data (store.db, config); use --purge to remove');
  return log;
}
