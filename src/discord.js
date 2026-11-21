// Read-only Discord access for the owner's mailbox channel and team channels. GET requests only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const API = 'https://discord.com/api/v10';
const DISCORD_EPOCH = 1420070400000n;

// The Discord message id that corresponds to a point in time.
export const snowflake = (iso) => String((BigInt(Date.parse(iso)) - DISCORD_EPOCH) << 22n);

// The bot token saved by /discord:configure.
export function loadToken(env = process.env, file = env.DISCORD_ENV_FILE ?? path.join(os.homedir(), '.claude', 'channels', 'discord', '.env')) {
  if (env.DISCORD_BOT_TOKEN) return env.DISCORD_BOT_TOKEN;
  if (!fs.existsSync(file)) return undefined;
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('DISCORD_BOT_TOKEN='));
  return line?.slice('DISCORD_BOT_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
}

async function get(url, token, fetchFn, sleep) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetchFn(url, { headers: { Authorization: `Bot ${token}` } });
    const body = await r.json().catch(() => null);
    if (r.ok) return body;
    if (r.status === 429 && attempt === 0) {
      await sleep(Math.ceil((body?.retry_after ?? 1) * 1000));
      continue;
    }
    throw new Error(body?.code ? `${body.code} ${body.message}` : `HTTP ${r.status}`);
  }
}


// Read-only dump of one channel since an ISO time: one "[time author] text" line per message.
export async function channelLines({ since, channel, token = loadToken, read = readAfter, cfg = config() }) {
  const CHANNELS = cfg.discord.channels;
  channel ??= cfg.discord.defaultChannel;
  if (Number.isNaN(Date.parse(since ?? ''))) throw new Error('Usage: cli.js discord <since, ISO time> [channel]');
  const name = String(channel).replace(/^#/, '');
  const channelId = CHANNELS[name] ?? (/^\d{17,20}$/.test(name) ? name : null);
  if (!channelId) throw new Error(`Unknown channel "${channel}". Use one of: ${Object.keys(CHANNELS).join(', ')}, or a channel id.`);
  const t = token();
  if (!t) throw new Error('no bot token (DISCORD_BOT_TOKEN, DISCORD_ENV_FILE or ~/.claude/channels/discord/.env)');
  const rows = await read({ token: t, after: snowflake(since), channelId });
  const embeds = (m) => (m.embeds ?? []).map((e) => [e.title, e.description].filter(Boolean).join(' | '));
  return rows.map((m) => `[${m.timestamp} ${m.author?.global_name || m.author?.username || '?'}] ${[m.content, ...embeds(m)].filter(Boolean).join(' | ')}`);
}

// Every message after message id `after`, oldest first. Discord returns up to 100 per page.
export async function readAfter({ token, after, channelId = config().discord.mailbox.id, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const rows = [];
  for (;;) {
    const page = await get(`${API}/channels/${channelId}/messages?limit=100&after=${after}`, token, fetchFn, sleep);
    const sorted = [...page].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    rows.push(...sorted);
    if (page.length < 100) return rows;
    after = sorted.at(-1).id;
  }
}
