import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.mjs';

export function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crazy-test-'));
  const files = {
    'src/auth/service.js': `import { SessionManager } from '../session.js';\nexport class AuthService {\n  constructor(repo) { this.repo = repo; }\n  async login(email, pw) {\n    return new SessionManager().create(email);\n  }\n  refresh(token) {\n    return token;\n  }\n}\nexport function hashPassword(pw) { return pw; }\n`,
    'src/session.js': `export class SessionManager {\n  create(user) { return { user }; }\n}\n`,
    'src/auth/middleware.js': `import { AuthService } from './service.js';\nexport const authMiddleware = (req, res, next) => { new AuthService(null).refresh(req.token); next(); };\n`,
    'src/util.py': `class Helper:\n    def run(self):\n        return 1\n\ndef standalone():\n    pass\n`,
    'test/auth.test.js': `import { AuthService } from '../src/auth/service.js';\nconsole.log('1 passed');\n`,
    ...extra,
  };
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), t); }
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-qm', 'feat: init');
  return { root, ctx: open(root), write: (f, t) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), t); } };
}
