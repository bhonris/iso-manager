// History: one Markdown file per issue (worklog/903.md, worklog/portal-A81.md), append-only.
import fs from 'node:fs';
import path from 'node:path';
import { idOf, refOf } from './board.js';

export function logPath(dir, ref) {
  const id = idOf(ref);
  const name = /^\d+$/.test(id) ? id : /^A\d+$/.test(id) ? `portal-${id}` : id.replace(/[^\w-]+/g, '-');
  return path.join(dir, `${name}.md`);
}

const local = (d, { offsetHours = 0, label = 'UTC' } = {}) => `${new Date(d.getTime() + offsetHours * 3600_000).toISOString().slice(0, 16).replace('T', ' ')} ${label}`;

export function appendLog(dir, ref, text, { title, status, now = new Date(), tz } = {}) {
  const file = logPath(dir, ref);
  fs.mkdirSync(dir, { recursive: true });
  const head = fs.existsSync(file) ? '' : `# ${[refOf(idOf(ref)), title].filter(Boolean).join(' ')}\n`;
  fs.appendFileSync(file, `${head}\n## ${local(now, tz)}${status ? ` · ${status}` : ''}\n${String(text).trim()}\n`, 'utf8');
  return file;
}

// When the issue was last worked on: the date (and time) that starts the newest entry's heading.
export function lastEntry(dir, ref) {
  const file = logPath(dir, ref);
  if (!fs.existsSync(file)) return null;
  const heads = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('## '));
  if (!heads.length) return null;
  const head = heads.at(-1).slice(3).trim();
  return /^\d{4}-\d{2}-\d{2}(?: ~?\d{2}:\d{2}(?: [A-Z]{2,5})?)?/.exec(head)?.[0] ?? head.slice(0, 20);
}
