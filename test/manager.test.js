import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Board, idOf, refOf } from '../src/board.js';
import { run } from '../src/cli.js';
import { config, loadConfig, normalize } from '../src/config.js';
import { channelLines, loadToken, readAfter, snowflake } from '../src/discord.js';

process.env.ISO_MANAGER_CONFIG = 'config.example.json';
const cfg = config();
const CHANNELS = cfg.discord.channels;
const MAILBOX = cfg.discord.mailbox;

describe('channelLines', () => {
  const msgs = [{ timestamp: 't1', author: { username: 'bob' }, content: 'hi', embeds: [{ title: 'T', description: 'D' }] }, { timestamp: 't2', content: '' }];
  it('reads a named channel after the since time', async () => {
    let got;
    const lines = await channelLines({ since: '2026-11-20T00:00:00Z', channel: '#pr', token: () => 'x', read: async (a) => { got = a; return msgs; } });
    expect(got.channelId).toBe(CHANNELS.pr);
    expect(got.after).toBe(snowflake('2026-11-20T00:00:00Z'));
    expect(lines).toEqual(['[t1 bob] hi | T | D', '[t2 ?] ']);
  });
  it('defaults to iso-27001 and accepts a raw id', async () => {
    const ids = [];
    const read = async (a) => { ids.push(a.channelId); return []; };
    await channelLines({ since: '2026-11-20T00:00:00Z', token: () => 'x', read });
    await channelLines({ since: '2026-11-20T00:00:00Z', channel: '123456789012345678', token: () => 'x', read });
    expect(ids).toEqual([CHANNELS['iso-27001'], '123456789012345678']);
  });
  it('rejects bad input and a missing token', async () => {
    await expect(channelLines({ since: 'nope' })).rejects.toThrow(/Usage/);
    await expect(channelLines({ since: '2026-11-20T00:00:00Z', channel: 'general', token: () => 'x' })).rejects.toThrow(/Unknown channel/);
    await expect(channelLines({ since: '2026-11-20T00:00:00Z', token: () => undefined })).rejects.toThrow(/no bot token/);
  });
});
import { backfill, textOf, tick, toAsk } from '../src/watch.js';
import { appendLog, lastEntry, logPath } from '../src/worklog.js';

const REPO = `https://github.com/${cfg.github.repo}`;
const now = () => new Date('2026-11-21T08:00:00.000Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'isom-'));
const setup = () => {
  const dir = tmp();
  const board = new Board(path.join(dir, 'data', 'state.json'));
  return { dir, board, opts: { board, worklogDir: path.join(dir, 'worklog'), now } };
};
const msg = (id, content, extra = {}) => ({ id: String(id), timestamp: '2026-11-21T07:00:00.000Z', author: { username: 'hook', global_name: 'Ping from Dana (DPO)' }, content, mentions: [], embeds: [], ...extra });
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
const ask = (id, extra = {}) => ({ id, title: `t${id}`, ask: `a${id}`, from: 'bob', at: '2026-11-20T00:00:00Z', url: 'u', text: 'full', ...extra });

describe('discord', () => {
  it('turns a time into a message id', () => {
    expect(snowflake('2015-01-01T00:00:00.000Z')).toBe('0');
    expect(snowflake('2015-01-01T00:00:00.001Z')).toBe(String(1n << 22n));
  });

  it('loads the bot token from the environment or the env file', () => {
    expect(loadToken({ DISCORD_BOT_TOKEN: 'e' })).toBe('e');
    const file = path.join(tmp(), '.env');
    expect(loadToken({}, file)).toBeUndefined();
    fs.writeFileSync(file, 'OTHER=1\nDISCORD_BOT_TOKEN="abc"\n');
    expect(loadToken({}, file)).toBe('abc');
    expect(loadToken({ DISCORD_ENV_FILE: file })).toBe('abc');
    fs.writeFileSync(file, 'OTHER=1\n');
    expect(loadToken({}, file)).toBeUndefined();
  });

  it('pages after a message id, oldest first, GET only', async () => {
    const calls = [];
    const pages = [Array.from({ length: 100 }, (_, i) => ({ id: String(200 - i) })), [{ id: '201' }]];
    const rows = await readAfter({ token: 't', after: '100', fetchFn: async (url, opts) => { calls.push({ url, opts }); return reply(200, pages.shift()); } });
    expect(rows[0].id).toBe('101');
    expect(rows.at(-1).id).toBe('201');
    expect(calls[0].url).toContain(`/channels/${MAILBOX.id}/messages?limit=100&after=100`);
    expect(calls[1].url).toContain('after=200');
    expect(calls.every((c) => !c.opts.method && c.opts.headers.Authorization === 'Bot t')).toBe(true);
  });

  it('retries once after a 429 and throws on errors', async () => {
    const seq = [reply(429, { retry_after: 0 }), reply(200, [])];
    expect(await readAfter({ token: 't', after: '1', fetchFn: async () => seq.shift(), sleep: async () => {} })).toEqual([]);
    const slept = [];
    const seq2 = [reply(429, {}), reply(200, [])];
    await readAfter({ token: 't', after: '1', fetchFn: async () => seq2.shift(), sleep: async (ms) => slept.push(ms) });
    expect(slept).toEqual([1000]);
    await expect(readAfter({ token: 't', after: '1', fetchFn: async () => reply(403, { code: 50001, message: 'Missing Access' }) })).rejects.toThrow('50001 Missing Access');
    await expect(readAfter({ token: 't', after: '1', fetchFn: async () => ({ ok: false, status: 500, json: async () => { throw new Error('x'); } }) })).rejects.toThrow('HTTP 500');
  });
});

describe('board', () => {
  it('normalises refs', () => {
    expect([idOf('903'), idOf('#903'), idOf('PR #903'), idOf('a81'), idOf('m55'), idOf(undefined)]).toEqual(['903', '903', '903', 'A81', 'm55', '']);
    expect([refOf('903'), refOf('A81')]).toEqual(['#903', 'A81']);
  });

  it('keeps one row per issue and brings pending or done rows back on a new ping', () => {
    const { board } = setup();
    expect(board.load()).toEqual({ cursor: null, mailbox: null, items: {} });
    expect(board.ping(ask('903'), now())).toMatchObject({ id: '903', status: 'open', created: now().toISOString() });
    board.setStatus('903', 'pending', { waiting: { on: 'bob', for: 'fix PR' }, now: now() });
    expect(board.get('#903')).toMatchObject({ status: 'pending', waitingOn: 'bob', waitingFor: 'fix PR', since: now().toISOString() });
    const back = board.ping(ask('903', { title: 'done it', at: '2026-11-21T00:00:00Z' }), now());
    expect(back).toMatchObject({ status: 'open', was: 'pending on bob', title: 'done it', waitingOn: undefined });
    expect(back.pings).toHaveLength(2);
    board.setStatus('903', 'done', { now: now() });
    expect(board.get('903')).toMatchObject({ status: 'done', doneAt: now().toISOString() });
    expect(board.get('903').was).toBeUndefined();
    expect(board.ping(ask('903'), now())).toMatchObject({ status: 'open', was: 'done' });
    expect(board.setStatus('903', 'open').was).toBe('done');
  });

  it('retries the save while another process holds the file, and gives up on other errors', () => {
    const { board } = setup();
    const real = board.rename.bind(board);
    let fails = 2;
    board.rename = (a, b) => {
      if (fails-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      real(a, b);
    };
    board.ping(ask('1'), now());
    expect(board.get('1').status).toBe('open');
    board.rename = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    expect(() => board.ping(ask('2'), now())).toThrow('gone');
    board.rename = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    expect(() => board.ping(ask('3'), now())).toThrow('busy');
  });

  it('flags news on a row in progress and clears it when seen', () => {
    const { board } = setup();
    board.ping(ask('5'), now());
    board.setStatus('5', 'in_progress', { now: now() });
    expect(board.ping(ask('5'), now())).toMatchObject({ status: 'in_progress', news: true });
    expect(board.setStatus('5', 'in_progress').news).toBe(true);
    expect(board.seen('5').news).toBeUndefined();
    expect(board.seen('5').news).toBeUndefined();
    expect(board.seen('nope')).toBeUndefined();
    expect(board.setStatus('nope', 'done')).toBeUndefined();
    for (let i = 0; i < 12; i++) board.ping(ask('5'), now());
    expect(board.get('5').pings).toHaveLength(10);
    expect(board.setStatus('5', 'pending', { waiting: { on: 'carol' } })).toMatchObject({ waitingFor: undefined, news: undefined });
  });

  it('lists by view, in progress first then newest ask', () => {
    const { board } = setup();
    board.ping(ask('1', { at: '2026-11-19T00:00:00Z' }), now());
    board.ping(ask('2', { at: '2026-11-20T00:00:00Z' }), now());
    board.ping(ask('3', { at: undefined }), now());
    board.ping(ask('4'), now());
    board.setStatus('1', 'in_progress');
    board.setStatus('4', 'done');
    expect(board.list().map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(board.list('done').map((i) => i.id)).toEqual(['4']);
    expect(board.list('all')).toHaveLength(4);
    expect(board.list('pending')).toEqual([]);
  });
});

describe('worklog', () => {
  it('names files per issue and appends dated entries', () => {
    const dir = path.join(tmp(), 'worklog');
    expect(path.basename(logPath(dir, '#903'))).toBe('903.md');
    expect(path.basename(logPath(dir, 'a81'))).toBe('portal-A81.md');
    expect(path.basename(logPath(dir, 'm:5/x'))).toBe('m-5-x.md');
    expect(lastEntry(dir, '903')).toBeNull();
    const file = appendLog(dir, '903', ' posted ', { title: 'CHG', status: 'in_progress', now: now(), tz: cfg.timezone });
    appendLog(dir, '903', 'second', { now: new Date('2026-11-21T09:30:00Z') });
    expect(fs.readFileSync(file, 'utf8')).toBe('# #903 CHG\n\n## 2026-11-21 15:00 ICT · in_progress\nposted\n\n## 2026-11-21 09:30 UTC\nsecond\n');
    expect(lastEntry(dir, '903')).toBe('2026-11-21 09:30 UTC');
    fs.writeFileSync(logPath(dir, '7'), '# x\n\n## 2026-11-17 (free text after the date)\n- a\n');
    expect(lastEntry(dir, '7')).toBe('2026-11-17');
    fs.writeFileSync(logPath(dir, '6'), ['## 2026-11-20 ~15:45 ICT — final', '## Some free heading that is long', ''].join('\n'));
    expect(lastEntry(dir, '6')).toBe('Some free heading th');
    fs.writeFileSync(logPath(dir, '6'), ['## 2026-11-20 ~15:45 ICT — final', ''].join('\n'));
    expect(lastEntry(dir, '6')).toBe('2026-11-20 ~15:45 ICT');
    fs.writeFileSync(logPath(dir, '8'), 'no entries\n');
    expect(lastEntry(dir, '8')).toBeNull();
    expect(fs.readFileSync(appendLog(dir, 'A9', 'x', { now: now() }), 'utf8')).toMatch(/^# A9\n/);
  });
});

describe('toAsk', () => {
  it('finds the issue from a link, else the first #N, else gives the message its own row', () => {
    const a = toAsk(msg(7, `<@1> PR ready ${REPO}/pull/1349 see #12`, { mentions: [{ id: '1', username: cfg.owner.discord }] }));
    expect(a).toMatchObject({ id: '1349', from: 'Dana (DPO)', at: '2026-11-21T07:00:00.000Z', url: `https://discord.com/channels/${cfg.discord.guild}/${MAILBOX.id}/7` });
    expect(a.title.startsWith('PR ready')).toBe(true);
    expect(toAsk(msg(8, `see ${REPO}/issues/903#issuecomment-1`)).id).toBe('903');
    expect(toAsk(msg(1, 'gate of build #407 for #478')).id).toBe('407');
    expect(toAsk(msg(2, 'open the mailbox', { author: { username: 'carol' } }))).toMatchObject({ id: 'm2', from: 'carol' });
    expect(toAsk(msg(3, 'https://example.com/page#12 nothing')).id).toBe('m3');
    expect(toAsk(msg(4, 'x', { author: undefined })).from).toBe('?');
  });

  it('skips the owner\'s own and empty messages, and reads embeds', () => {
    expect(toAsk(msg(1, 'note', { author: { username: cfg.owner.discord } }))).toBeNull();
    expect(toAsk(msg(2, ''))).toBeNull();
    expect(toAsk({ id: '5' })).toBeNull();
    const m = msg(3, '', { embeds: [{ title: 'Scan', description: 'found', fields: [{ name: 'repo', value: 'x #55' }] }, {}] });
    expect(textOf(m)).toBe('Scan | found | repo: x #55');
    expect(toAsk(m).id).toBe('55');
    expect(textOf(msg(4, 'hi <@9>'))).toBe('hi <@9>');
  });
});

describe('tick', () => {
  it('puts pings on the board, prints one line each and moves the cursor', async () => {
    const { board } = setup();
    board.ping(ask('617'), now());
    board.setStatus('617', 'pending', { waiting: { on: 'bob' } });
    board.ping(ask('848'), now());
    board.setStatus('848', 'in_progress');
    const calls = [];
    const pages = [[msg(31, 'new ask on #903'), msg(32, 'bob done #617'), msg(33, 'gate #848'), msg(34, 'mine', { author: { username: cfg.owner.discord } })], []];
    const read = async (a) => { calls.push(a); return pages.shift(); };
    expect(await tick({ board, read, token: () => 't', now })).toEqual([
      'PING 903 | Dana (DPO) | open | new ask on #903',
      'PING 617 | Dana (DPO) | open (was pending on bob) | bob done #617',
      'PING 848 | Dana (DPO) | in_progress (news) | gate #848',
    ]);
    expect(calls[0]).toEqual({ token: 't', after: snowflake(now().toISOString()) });
    expect(board.load()).toMatchObject({ cursor: '34', mailbox: { at: now().toISOString() } });
    expect(await tick({ board, read, token: () => 't', now })).toEqual([]);
    expect(calls[1].after).toBe('34');
    expect(board.load().cursor).toBe('34');
  });

  it('keeps the cursor and reports a failing mailbox once', async () => {
    const { board } = setup();
    board.change((s) => { s.cursor = '5'; });
    const bad = async () => { throw new Error('50001 Missing Access'); };
    expect(await tick({ board, read: bad, token: () => 't', now })).toEqual(['MAILBOX ERROR 50001 Missing Access']);
    expect(await tick({ board, read: bad, token: () => 't', now })).toEqual([]);
    expect(board.load()).toMatchObject({ cursor: '5', mailbox: { error: '50001 Missing Access' } });
    expect(await tick({ board, read: async () => [msg(6, 'ok')], token: () => 't', now })).toHaveLength(1);
    expect(board.load()).toMatchObject({ cursor: '6', mailbox: { at: now().toISOString() } });
    expect(board.load().mailbox.error).toBeUndefined();
    expect(await tick({ board, read: async () => [], token: () => undefined, now })).toEqual(['MAILBOX ERROR no bot token']);
  });
});

describe('backfill', () => {
  it('loads older messages up to the cursor and never replaces a newer ask', async () => {
    const { board } = setup();
    board.change((s) => { s.cursor = '40'; });
    board.ping(ask('903', { at: '2026-11-21T07:30:00.000Z', title: 'newer' }), now());
    const calls = [];
    const read = async (a) => { calls.push(a); return [msg(10, 'old ask #903'), msg(11, 'old ask #617'), msg(12, 'mine', { author: { username: cfg.owner.discord } }), msg(41, 'after cursor #1')]; };
    expect(await backfill({ board, since: '2026-11-20T00:00:00Z', read, token: () => 't', now })).toBe(2);
    expect(calls[0]).toEqual({ token: 't', after: snowflake('2026-11-20T00:00:00Z') });
    expect(board.get('903').title).toBe('newer');
    expect(board.get('617').status).toBe('open');
    expect(board.get('1')).toBeUndefined();
    expect(board.load().cursor).toBe('40');
  });

  it('sets the cursor when there was none', async () => {
    const { board } = setup();
    expect(await backfill({ board, since: '2026-11-20T00:00:00Z', read: async () => [msg(10, 'x #5')], token: () => 't', now })).toBe(1);
    expect(board.load().cursor).toBe('10');
    expect(await backfill({ board, since: '2026-11-20T00:00:00Z', read: async () => [], token: () => 't', now })).toBe(0);
  });
});

describe('cli', () => {
  it('lists the board with status, sender and last worked date', () => {
    const { board, opts } = setup();
    expect(run(['list'], opts)).toEqual([0, 'inbox: 0 · pending 0 · mailbox never read']);
    board.ping(ask('903', { title: 'Change 12' }), now());
    board.ping(ask('A81', { from: undefined }), now());
    run(['start', 'a81'], opts);
    run(['log', '903', 'did', 'it'], opts);
    board.change((s) => { s.mailbox = { at: 'T' }; });
    expect(run(['list'], opts)[1].split('\n')).toEqual([
      'inbox: 2 · pending 0 · mailbox read T',
      'A81 | in_progress | tA81 | from ? | last worked never',
      '#903 | open | Change 12 | from bob | last worked 2026-11-21 15:00 ICT',
    ]);
    board.change((s) => { s.mailbox = { error: 'boom' }; });
    expect(run(['list', 'all'], opts)[1]).toContain('all: 2 · pending 0 · mailbox error: boom');
    expect(run(['list', 'nope'], opts)[0]).toBe(1);
  });

  it('moves a row through start, pending and done', () => {
    const { board, opts } = setup();
    board.ping(ask('903'), now());
    expect(run(['start', '#903'], opts)[1]).toContain('#903 | in_progress |');
    board.ping(ask('903'), now());
    expect(run(['list'], opts)[1]).toContain('in_progress +news');
    expect(run(['pending', '903'], opts)[0]).toBe(1);
    expect(run(['pending', '903', 'TM'], opts)[1]).toContain('stays in progress');
    expect(run(['pending', '903', 'bob', 'fix', 'PR'], opts)[1]).toBe('#903 | pending on bob | t903 | fix PR | last worked never');
    expect(run(['list', 'pending'], opts)[1]).toContain('pending: 1 · pending 1');
    board.ping(ask('903'), now());
    expect(run(['list'], opts)[1]).toContain('#903 | open (was pending on bob) |');
    expect(run(['done', '903'], opts)[1]).toContain('#903 | done |');
  });

  it('adds by hand, shows an item with its pings, and logs even without a row', () => {
    const { board, opts } = setup();
    expect(run(['add', '953'], opts)[0]).toBe(1);
    expect(run(['add', '953', 'look', 'at', '953'], opts)[1]).toContain('#953 | open | look at 953 | from Alex');
    expect(run(['show', '953'], opts)[1]).toMatch(/ask: look at 953[\s\S]*work log: none yet[\s\S]*pings \(newest last, 1 kept\):\n\[2026-11-21T08:00:00.000Z Alex\] look at 953/);
    const [, out] = run(['log', '953', 'reviewed'], opts);
    expect(run(['show', '953'], opts)[1]).toContain(`work log: ${out.replace('logged to ', '')}`);
    expect(run(['log', '953'], opts)[0]).toBe(1);
    expect(run(['log', '777', 'note with no row'], opts)[0]).toBe(0);
    board.change((s) => { s.items['9'] = { id: '9', status: 'open' }; });
    expect(run(['show', '9'], opts)[1]).toContain('pings (newest last, 0 kept):');
    board.setStatus('953', 'in_progress');
    board.ping(ask('953'), now());
    run(['show', '953'], opts);
    expect(board.get('953').news).toBeUndefined();
  });

  it('records what Bhon must do and shows it while the row is live', () => {
    const { board, opts } = setup();
    board.ping(ask('848'), now());
    expect(run(['todo', '848'], opts)[0]).toBe(1);
    expect(run(['todo', '848', 'press', 'the', 'gate'], opts)[1]).toBe('#848 | open | t848 | from bob | last worked never | TODO: press the gate');
    expect(board.get('848').todoAt).toBe(now().toISOString());
    expect(run(['list'], opts)[1]).toContain('TODO: press the gate');
    expect(run(['done', '848'], opts)[1]).not.toContain('TODO');
    expect(run(['todo', '999', 'x'], opts)[0]).toBe(1);
  });

  it('rejects unknown commands and rows', () => {
    const { opts } = setup();
    expect(run([], opts)[1]).toMatch(/^Usage/);
    expect(run(['nope', '1'], opts)[0]).toBe(1);
    expect(run(['show'], opts)[0]).toBe(1);
    expect(run(['done', '12345'], opts)[1]).toContain('No row for "12345"');
  });
});

describe('post', () => {
  const prep = (dir, id, text) => {
    fs.mkdirSync(path.join(dir, 'prep', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prep', id, 'comment.md'), text);
  };
  const URL = 'https://github.com/o/r/issues/903#issuecomment-1';
  it('posts, logs, renames and sets pending or done', () => {
    const { dir, board, opts } = setup();
    const calls = [];
    const o = { ...opts, prepDir: path.join(dir, 'prep'), exec: (a) => { calls.push(a); return `${URL}
`; } };
    board.ping(ask('903'), now());
    prep(dir, '903', 'ok to go');
    expect(run(['post', '#903', '--pending', 'bob', 'merge it'], o)).toEqual([0, `posted ${URL}`]);
    expect(calls[0].slice(0, 5)).toEqual(['issue', 'comment', '903', '--repo', cfg.github.repo]);
    expect(fs.existsSync(path.join(dir, 'prep', '903', 'comment.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'prep', '903', 'comment.posted.md'))).toBe(true);
    expect(fs.readFileSync(logPath(opts.worklogDir, '903'), 'utf8')).toContain(`posted ${URL}`);
    expect(board.get('903').status).toBe('pending');
    prep(dir, '903', 'again');
    expect(run(['post', '903', '--done'], o)[0]).toBe(0);
    expect(board.get('903').status).toBe('done');
    prep(dir, '903', 'plain');
    expect(run(['post', '903'], o)[0]).toBe(0);
  });
  it('refuses a missing file, placeholders, bad refs and bad flags', () => {
    const { dir, board, opts } = setup();
    const o = { ...opts, prepDir: path.join(dir, 'prep'), exec: () => { throw new Error('must not run'); } };
    board.ping(ask('903'), now());
    expect(run(['post', '903'], o)[1]).toMatch(/No prepared comment/);
    for (const bad of ['<BHON TO CONFIRM>', 'PENDING', 'see <number>']) {
      prep(dir, '903', `x ${bad}`);
      expect(run(['post', '903'], o)[1]).toMatch(/placeholder/);
    }
    expect(run(['post', 'A81'], o)[1]).toMatch(/Only an issue or PR number/);
    expect(run(['post', '903', '--bogus'], o)[1]).toMatch(/^Usage/);
    expect(run(['post', '903', '--pending'], o)[1]).toMatch(/^Usage/);
    expect(run(['post', '903', '--pending', 'TM', 'x'], o)[1]).toMatch(/stays in progress/);
    expect(run(['post', '777', '--done'], o)[1]).toMatch(/No row/);
  });
  it('leaves comment.md in place when gh fails or gives no URL', () => {
    const { dir, board, opts } = setup();
    board.ping(ask('903'), now());
    prep(dir, '903', 'ok');
    const file = path.join(dir, 'prep', '903', 'comment.md');
    expect(run(['post', '903'], { ...opts, prepDir: path.join(dir, 'prep'), exec: () => { throw new Error('boom'); } })[1]).toMatch(/gh failed.*boom/);
    expect(run(['post', '903'], { ...opts, prepDir: path.join(dir, 'prep'), exec: () => '' })[1]).toMatch(/no comment URL/);
    expect(fs.existsSync(file)).toBe(true);
    expect(board.get('903').status).toBe('open');
  });
});

describe('config', () => {
  it('loads the file named by ISO_MANAGER_CONFIG and derives owner aliases and channels', () => {
    expect(cfg.owner.aliases).toEqual(expect.arrayContaining(['alex-example', '@alex-example', 'alex.example', 'alex', 'tm']));
    expect(CHANNELS[MAILBOX.name]).toBe(MAILBOX.id);
    expect(cfg.timezone).toEqual({ offsetHours: 7, label: 'ICT' });
  });
  it('fills defaults and refuses missing values or a missing file', () => {
    const min = { owner: { name: 'A B', github: 'g', discord: 'd' }, github: { repo: 'o/r' }, discord: { guild: 'G', mailbox: { id: '1', name: 'mb' } } };
    expect(normalize(min)).toMatchObject({ discord: { defaultChannel: 'mb', channels: { mb: '1' } }, timezone: { offsetHours: 0, label: 'UTC' } });
    expect(() => normalize({ owner: {} })).toThrow(/missing: owner.name/);
    expect(() => loadConfig(path.join(tmp(), 'none.json'))).toThrow(/No config/);
  });
});
