// Mailbox watch: each new message in the owner's mailbox channel becomes (or updates) a board row. No model.
import { idOf } from './board.js';
import { config } from './config.js';
import { loadToken, readAfter, snowflake } from './discord.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// The message as plain text: mentions as @name, embeds appended.
export function textOf(m) {
  const names = new Map((m.mentions ?? []).map((u) => [u.id, u.username]));
  const content = String(m.content ?? '').replace(/<@!?(\d+)>/g, (all, id) => (names.has(id) ? `@${names.get(id)}` : all));
  const embeds = (m.embeds ?? []).map((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join(' | '));
  return [content, ...embeds].filter(Boolean).join('\n').trim();
}

// One mailbox message -> one ask (null for the owner's own or empty messages). The issue is the
// first issue/PR link to the configured repo in the text, else the first "#N"; without one the message
// gets a row of its own.
export function toAsk(m, cfg = config()) {
  const me = cfg.owner.discord;
  if (m.author?.username === me) return null;
  const text = textOf(m);
  if (!text) return null;
  const issueUrl = new RegExp(`github\\.com/${esc(cfg.github.repo)}/(?:issues|pull)/(\\d+)`, 'i');
  const n = issueUrl.exec(text)?.[1] ?? /(?:^|[^\w/])#(\d{1,5})\b/.exec(text)?.[1];
  const line = flat(text).replace(new RegExp(`^@${esc(me)}\\s*`, 'i'), '');
  return {
    id: idOf(n ?? `m${m.id}`),
    title: line.slice(0, 90),
    ask: line.slice(0, 300),
    from: flat(m.author?.global_name || m.author?.username || '?').replace(/^Ping from\s+/i, ''),
    at: m.timestamp,
    url: `https://discord.com/channels/${cfg.discord.guild}/${cfg.discord.mailbox.id}/${m.id}`,
    text: text.slice(0, 4000),
  };
}

// Loads older mailbox messages (from `since` up to where the watch started) onto the board.
// Rows that already have a newer ask keep it. Returns how many messages were loaded.
export async function backfill({ board, since, read = readAfter, token = loadToken, now = () => new Date() }) {
  const cursor = board.load().cursor;
  const rows = await read({ token: token(), after: snowflake(since) });
  const asks = rows.filter((m) => !cursor || BigInt(m.id) <= BigInt(cursor)).map((m) => toAsk(m)).filter(Boolean);
  for (const ask of asks) {
    const prev = board.get(ask.id);
    if (!prev || String(prev.at ?? '') < ask.at) board.ping(ask, now());
  }
  if (!cursor && rows.length) board.change((s) => { s.cursor = rows.at(-1).id; });
  return asks.length;
}

// One read of the mailbox. Returns the lines to print: one per ping, or one error line the
// first time reads start failing. The cursor moves only after the pings are on the board.
export async function tick({ board, read = readAfter, token = loadToken, now = () => new Date() }) {
  const before = board.load();
  const after = before.cursor ?? snowflake(now().toISOString());
  let rows;
  try {
    const t = token();
    if (!t) throw new Error('no bot token');
    rows = await read({ token: t, after });
  } catch (e) {
    board.change((s) => {
      s.cursor = after;
      s.mailbox = { ...(s.mailbox ?? {}), error: String(e.message).slice(0, 300), errorAt: now().toISOString() };
    });
    return before.mailbox?.error ? [] : [`MAILBOX ERROR ${e.message}`];
  }
  const lines = [];
  for (const ask of rows.map((m) => toAsk(m)).filter(Boolean)) {
    const row = board.ping(ask, now());
    const note = row.status === 'open' && row.was ? ` (was ${row.was})` : row.news ? ' (news)' : '';
    lines.push(`PING ${row.id} | ${ask.from} | ${row.status}${note} | ${ask.title}`);
  }
  board.change((s) => {
    s.cursor = rows.at(-1)?.id ?? after;
    s.mailbox = { at: now().toISOString() };
  });
  return lines;
}
