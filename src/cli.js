#!/usr/bin/env node
// iso-manager: the board, mailbox watch and work log behind one Claude Code manager session.
//   node src/cli.js watch                          long-running; one line per new mailbox ping
//   node src/cli.js backfill <ISO time>            load older mailbox messages, up to where the watch started
//   node src/cli.js discord <ISO time> [channel]   read-only dump of a team channel (GET only)
//   node src/cli.js list [pending|done|all]        the board (default: open + in progress)
//   node src/cli.js show <ref>                     one item: ask, recent pings, work log file
//   node src/cli.js add <ref> "<title>"            put an issue on the board by hand
//   node src/cli.js todo <ref> "<text>"            what the owner must do on this item (shown on the board)
//   node src/cli.js start <ref>                    -> in progress
//   node src/cli.js pending <ref> <who> [what they need to do]
//   node src/cli.js done <ref>
//   node src/cli.js log <ref> "<text>"             append to worklog/<n>.md
//   node src/cli.js post <ref> [--pending "<who>" "<note>"] [--done]   post data/prep/<id>/comment.md via gh (no model)
// <ref>: an issue or PR number (903, #903), a portal action (A81) or a row id from the board.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, idOf, refOf } from './board.js';
import { config } from './config.js';
import { channelLines } from './discord.js';
import { backfill, tick } from './watch.js';
import { appendLog, lastEntry, logPath } from './worklog.js';

const flat = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const USAGE = 'Usage: cli.js watch | list [pending|done|all] | show <ref> | add <ref> "<title>" | todo <ref> "<text>" | start <ref> | pending <ref> <who> [note] | done <ref> | log <ref> "<text>" | post <ref> [--pending "<who>" "<note>"] [--done]';
const PLACEHOLDER = /<[A-Z ]*TO CONFIRM>|\bPENDING\b|<number>/;
const isOwner = (who, cfg) => cfg.owner.aliases.includes(String(who).trim().toLowerCase());
const ON_OWNER = 'Pending means waiting on someone else. An item waiting on the owner stays in progress.';

function row(item, dir) {
  const state = item.status === 'pending' ? `pending on ${item.waitingOn}` : item.status + (item.news ? ' +news' : '') + (item.status === 'open' && item.was ? ` (was ${item.was})` : '');
  const detail = item.status === 'pending' ? flat(item.waitingFor, 80) : `from ${item.from ?? '?'}`;
  const todo = item.todo && item.status !== 'pending' && item.status !== 'done' ? ` | TODO: ${flat(item.todo, 400)}` : '';
  return `${refOf(item.id)} | ${state} | ${flat(item.title, 80)} | ${detail} | last worked ${lastEntry(dir, item.id) ?? 'never'}${todo}`;
}

// Posts an approved, prepared comment with gh (no model), logs the URL, marks it posted, updates the board.
function post(ref, rest, item, { board, worklogDir, prepDir, exec, now, cfg }) {
  const id = idOf(ref);
  if (!/^\d+$/.test(id)) return [1, `Only an issue or PR number can be posted to, not "${ref}".`];
  let pending = null;
  let done = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--done') done = true;
    else if (rest[i] === '--pending' && rest[i + 1]) pending = { who: rest[i + 1], note: rest[i += 2] ?? '' };
    else return [1, USAGE];
  }
  if (pending && isOwner(pending.who, cfg)) return [1, ON_OWNER];
  if ((pending || done) && !item) return [1, `No row for "${ref}". Add it first: cli.js add ${id} "<title>"`];
  const file = path.join(prepDir, id, 'comment.md');
  if (!fs.existsSync(file)) return [1, `No prepared comment at ${file}`];
  const bad = PLACEHOLDER.exec(fs.readFileSync(file, 'utf8'));
  if (bad) return [1, `${file} still has a placeholder (${bad[0]}). Nothing posted.`];
  let url;
  try {
    url = String(exec(['issue', 'comment', id, '--repo', cfg.github.repo, '--body-file', file]) ?? '').trim().split(/\s+/).find((w) => /^https?:\/\//.test(w));
  } catch (e) {
    return [1, `gh failed, comment.md left in place: ${flat(e.message, 300)}`];
  }
  if (!url) return [1, 'gh gave no comment URL. Check the issue before posting again; comment.md left in place.'];
  appendLog(worklogDir, ref, `posted ${url}`, { title: item?.title, status: item?.status, now: now(), tz: cfg.timezone });
  fs.renameSync(file, path.join(prepDir, id, 'comment.posted.md'));
  if (pending) board.setStatus(ref, 'pending', { waiting: { on: pending.who.slice(0, 80), for: pending.note.slice(0, 300) }, now: now() });
  else if (done) board.setStatus(ref, 'done', { now: now() });
  return [0, `posted ${url}`];
}

export function run(argv, { board, worklogDir, prepDir, exec, now = () => new Date(), cfg = config() }) {
  const [cmd, ref, ...rest] = argv;
  if (cmd === 'list') {
    const view = ref ?? 'inbox';
    if (!['inbox', 'pending', 'done', 'all'].includes(view)) return [1, USAGE];
    const items = board.list(view);
    const s = board.load();
    const mailbox = s.mailbox?.error ? `error: ${s.mailbox.error}` : s.mailbox?.at ? `read ${s.mailbox.at}` : 'never read';
    return [0, [`${view}: ${items.length} · pending ${board.list('pending').length} · mailbox ${mailbox}`, ...items.map((i) => row(i, worklogDir))].join('\n')];
  }
  if (!['show', 'add', 'todo', 'start', 'pending', 'done', 'log', 'post'].includes(cmd) || !ref) return [1, USAGE];
  if (cmd === 'add') {
    const title = rest.join(' ').trim();
    if (!title) return [1, 'Give it a title: cli.js add <ref> "<title>"'];
    const iso = now().toISOString();
    return [0, row(board.ping({ id: ref, title, ask: title, from: cfg.owner.name.split(/\s+/)[0], at: iso, text: title }, now()), worklogDir)];
  }
  const item = board.get(ref);
  if (cmd === 'log') {
    const text = rest.join(' ').trim();
    if (!text) return [1, 'Say what to log: cli.js log <ref> "<what was done, decided, links, what is left>"'];
    return [0, `logged to ${appendLog(worklogDir, ref, text, { title: item?.title, status: item?.status, now: now(), tz: cfg.timezone })}`];
  }
  if (cmd === 'post') return post(ref, rest, item, { board, worklogDir, prepDir, exec, now, cfg });
  if (!item) return [1, `No row for "${ref}". See: cli.js list all, or add it: cli.js add ${idOf(ref)} "<title>"`];
  if (cmd === 'todo') {
    const text = rest.join(' ').trim();
    if (!text) return [1, 'Say what the owner must do: cli.js todo <ref> "<action; recommendation; due>"'];
    return [0, row(board.change((s) => Object.assign(s.items[item.id], { todo: text.slice(0, 1000), todoAt: now().toISOString() })), worklogDir)];
  }
  if (cmd === 'show') {
    board.seen(ref);
    const file = logPath(worklogDir, ref);
    return [0, [
      row(item, worklogDir), `ask: ${item.ask ?? ''}`, `asked: ${item.from ?? '?'} at ${item.at ?? '?'} · ${item.url ?? ''}`,
      `work log: ${fs.existsSync(file) ? file : `none yet (${file})`}`, '', `pings (newest last, ${item.pings?.length ?? 0} kept):`,
      ...(item.pings ?? []).map((p) => `[${p.at} ${p.from}] ${p.text}`),
    ].join('\n')];
  }
  if (cmd === 'pending') {
    const [who, ...note] = rest;
    if (!who) return [1, 'Say who it is waiting on: cli.js pending <ref> <who> "<what they need to do>"'];
    if (isOwner(who, cfg)) return [1, ON_OWNER];
    return [0, row(board.setStatus(ref, 'pending', { waiting: { on: who.slice(0, 80), for: note.join(' ').slice(0, 300) }, now: now() }), worklogDir)];
  }
  return [0, row(board.setStatus(ref, cmd === 'start' ? 'in_progress' : 'done', { now: now() }), worklogDir)];
}

/* c8 ignore start */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main().catch((e) => { console.error(e); process.exitCode = 1; });
async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const board = new Board(path.join(root, 'data', 'state.json'));
  const argv = process.argv.slice(2);
  if (argv[0] === 'watch') {
    const every = Number(process.env.ISO_WATCH_SECONDS || 60) * 1000;
    for (;;) {
      for (const line of await tick({ board })) console.log(line);
      await new Promise((r) => setTimeout(r, every));
    }
  }
  if (argv[0] === 'backfill') {
    if (Number.isNaN(Date.parse(argv[1] ?? ''))) { console.error('Usage: cli.js backfill <since, ISO time>'); process.exitCode = 1; return; }
    console.log(`loaded ${await backfill({ board, since: argv[1] })} mailbox messages since ${argv[1]}`);
    return;
  }
  if (argv[0] === 'discord') {
    try {
      console.log((await channelLines({ since: argv[1], channel: argv[2] })).join('\n'));
      return;
    } catch (e) { console.error(e.message); process.exitCode = 1; return; }
  }
  const exec = (args) => execFileSync('gh', args, { encoding: 'utf8' });
  const [code, out] = run(argv, { board, worklogDir: path.join(root, 'worklog'), prepDir: path.join(root, 'data', 'prep'), exec });
  (code ? console.error : console.log)(out);
  process.exitCode = code;
}
/* c8 ignore stop */
