// Per-user settings: who you are, your ISMS repo, your Discord mailbox. Read from
// config.local.json (git-ignored) in the project root, or the file named by ISO_MANAGER_CONFIG.
// See config.example.json and README.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let cached = null;

// Fills in derived values and checks the required ones.
export function normalize(raw) {
  const need = ['owner.name', 'owner.github', 'owner.discord', 'github.repo', 'discord.guild', 'discord.mailbox.id', 'discord.mailbox.name'];
  const missing = need.filter((k) => !k.split('.').reduce((o, p) => o?.[p], raw));
  if (missing.length) throw new Error(`config is missing: ${missing.join(', ')}`);
  const { owner, github, discord } = raw;
  const channels = { ...(discord.channels ?? {}), [discord.mailbox.name]: discord.mailbox.id };
  const aliases = [owner.github, `@${owner.github}`, owner.discord, owner.name.split(/\s+/)[0], ...(owner.aliases ?? [])];
  return {
    owner: { ...owner, aliases: aliases.map((a) => String(a).toLowerCase()) },
    github: { repo: github.repo },
    discord: { guild: discord.guild, mailbox: discord.mailbox, channels, defaultChannel: discord.defaultChannel ?? Object.keys(channels)[0] },
    timezone: { offsetHours: raw.timezone?.offsetHours ?? 0, label: raw.timezone?.label ?? 'UTC' },
  };
}

export function loadConfig(file = process.env.ISO_MANAGER_CONFIG || path.join(ROOT, 'config.local.json')) {
  const full = path.resolve(ROOT, file);
  if (!fs.existsSync(full)) throw new Error(`No config at ${full}. Copy config.example.json to config.local.json and fill it in.`);
  return normalize(JSON.parse(fs.readFileSync(full, 'utf8')));
}

// The config for this process, loaded once.
export function config() {
  cached ??= loadConfig();
  return cached;
}
