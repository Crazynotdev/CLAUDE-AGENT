// Transcript analysis: where did the tokens go, and what was avoidable.
// Provider-reported usage is exact; category shares and waste are estimates (bytes/4), labelled as such.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tok } from './util.mjs';

export const transcriptDir = (root) => join(homedir(), '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));

export function latestTranscript(root) {
  const d = transcriptDir(root);
  if (!existsSync(d)) return null;
  const files = readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f: join(d, f), m: statSync(join(d, f)).mtimeMs }));
  return files.sort((a, b) => b.m - a.m)[0]?.f ?? null;
}

const TEST_RE = /\b(test|jest|pytest|vitest|mocha|tap|go test|cargo test)\b/i;
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? '').join('\n') : '';
const cat = (name, input) => {
  if (['Read', 'Grep', 'Glob', 'LS'].includes(name)) return 'exploration';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'implementation';
  if (name === 'Task' || name === 'Agent') return 'agents';
  if (name === 'Bash') {
    const c = input?.command ?? '';
    if (/\.crazy\/crazy|(^|\s)crazy\s/.test(c)) return 'crazy';
    return TEST_RE.test(c) ? 'tests' : 'tool_output';
  }
  return 'other';
};

export function analyzeTranscript(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const msgs = new Map(); const uses = new Map(); const est = {}; const add = (k, n) => { est[k] = (est[k] ?? 0) + n; };
  const toolCalls = {}; const reads = new Map(); const waste = { repeatedReading: 0, repeatedCommands: 0, failedAttempts: 0, overlongOutput: 0 };
  const lastEdit = new Map(); const seenCmd = new Map(); let editSeq = 0; let compactions = 0; let unknown = 0;
  const files = new Set(); const models = {};
  for (const ln of lines) {
    let o; try { o = JSON.parse(ln); } catch { unknown++; continue; }
    if (o.type === 'summary' || o.isCompactSummary || o.subtype === 'compact_boundary') compactions++;
    const m = o.message; if (!m) continue;
    if (o.type === 'assistant' && m.usage) { msgs.set(m.id ?? o.uuid, m.usage); if (m.model) models[m.model] = (models[m.model] ?? 0) + 1; }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'text' && o.type === 'assistant') add('reasoning', tok(b.text));
      else if (b.type === 'thinking') add('reasoning', tok(b.thinking));
      else if (b.type === 'tool_use') {
        const c = cat(b.name, b.input); uses.set(b.id, { c, name: b.name, input: b.input, seq: editSeq });
        toolCalls[b.name] = (toolCalls[b.name] ?? 0) + 1; add(c, tok(JSON.stringify(b.input)));
        if (b.name === 'Read' && b.input?.file_path) files.add(b.input.file_path);
        if (c === 'implementation') { editSeq++; lastEdit.set(b.input?.file_path, editSeq); }
      } else if (b.type === 'tool_result') {
        const u = uses.get(b.tool_use_id); const t = tok(textOf(b.content)); add(u?.c ?? 'other', t);
        if (b.is_error) { waste.failedAttempts += t; }
        if (u?.name === 'Read' && !u.input?.offset && !u.input?.limit) {
          const p = u.input?.file_path; const prev = reads.get(p);
          if (prev !== undefined && (lastEdit.get(p) ?? 0) <= prev) waste.repeatedReading += t;
          reads.set(p, editSeq);
        }
        if (u?.name === 'Bash') {
          const cmd = u.input?.command; const prev = seenCmd.get(cmd);
          if (prev !== undefined && prev === editSeq && u.c !== 'crazy') waste.repeatedCommands += t;
          seenCmd.set(cmd, editSeq);
          if (u.c !== 'crazy' && t > 2000) waste.overlongOutput += t - 500;
        }
      }
    }
  }
  const sum = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let lastCtx = 0;
  for (const u of msgs.values()) {
    sum.input += u.input_tokens ?? 0; sum.output += u.output_tokens ?? 0;
    sum.cacheWrite += u.cache_creation_input_tokens ?? 0; sum.cacheRead += u.cache_read_input_tokens ?? 0;
    lastCtx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  }
  return { turns: msgs.size, usage: sum, lastContext: lastCtx, estimate: est, toolCalls, toolCallTotal: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    filesRead: files.size, waste, compactions, models, unparsedLines: unknown, fieldsSeen: { usage: msgs.size > 0, toolUse: uses.size > 0 } };
}

export const weighted = (u, w = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }) =>
  u.input * w.input + u.output * w.output + u.cacheWrite * w.cacheWrite + u.cacheRead * w.cacheRead;

export function formatCost(a, injectedTok = 0) {
  const u = a.usage; const tot = u.input + u.output + u.cacheWrite + u.cacheRead;
  const e = a.estimate; const eSum = Object.values(e).reduce((x, y) => x + y, 0) || 1;
  const pct = (n) => `${Math.round((n / eSum) * 100)}%`;
  const rows = Object.entries(e).sort((x, y) => y[1] - x[1]).map(([k, v]) => `  ${pct(v).padStart(4)} ${k}`);
  const wsum = Object.values(a.waste).reduce((x, y) => x + y, 0);
  const reuse = u.cacheRead / Math.max(1, u.input + u.cacheWrite + u.cacheRead);
  return [
    `SESSION (provider-reported): turns=${a.turns} input=${u.input} output=${u.output} cache_write=${u.cacheWrite} cache_read=${u.cacheRead} total=${tot}`,
    `weighted cost units (1/5/1.25/0.1 ratio, assumption): ${Math.round(weighted(u))}`,
    `context now: ${a.lastContext} tokens   compactions: ${a.compactions}   cache reuse: ${(reuse * 100).toFixed(0)}%`,
    `tool calls: ${a.toolCallTotal} (${Object.entries(a.toolCalls).map(([k, v]) => `${k}:${v}`).join(' ')})   files read: ${a.filesRead}   models: ${Object.keys(a.models).join(', ') || '?'}`,
    '', 'WHY TOKENS WERE SPENT (estimate, bytes/4 over tool inputs, results and text):', ...rows,
    '', 'WASTE (estimated tokens in tool results that added nothing new):',
    `  repeated reading   ${a.waste.repeatedReading}`, `  repeated commands  ${a.waste.repeatedCommands}`,
    `  failed tool calls  ${a.waste.failedAttempts}`, `  overlong outputs   ${a.waste.overlongOutput} (beyond ~500 tok, not via crazy run)`,
    `  estimated avoidable: ~${wsum} tokens of tool-result text (${pct(wsum)} of estimated volume)`,
    `  not measured: overpowered model, unused skills/MCP, premature exploration`,
    `SELF-COST: ${injectedTok} tokens injected by crazy hooks (estimate); crazy CLI calls: ${e.crazy ?? 0} tokens`,
    a.unparsedLines ? `note: ${a.unparsedLines} transcript lines could not be parsed` : ''].filter((x) => x !== undefined).join('\n');
}
