# iso-manager

A small tool for running your ISO 27001 work items from **one Claude Code session** ("manager mode"):

- a **mailbox watch**: each new message in your personal Discord mailbox channel becomes a row on a board, with no model call;
- a **board** (`data/state.json`): one row per issue, with status open / in progress / pending on someone / done, and a to-do note for you;
- a **work log** (`worklog/<n>.md`): one append-only history file per issue that any later session reads first;
- a **post** command that publishes a comment you approved to your ISMS GitHub repo with `gh`, with no model tokens.

No server, no web page.

## The manager-session pattern
You talk to one Claude Code session, the manager. It never does the work itself: it gives each issue to its own background subagent (briefed by `SUBAGENT.md`), which reads the thread and replies with a short verdict (TODO / WAITING / DONE). The manager updates the board and shows you **one** to-do at a time with a recommendation and a yes/no question. Approved actions go back to the same subagent as an `ACT:` message. Rules: `CLAUDE.md`.

## Setup
1. Node.js 20+, then `npm install`.
2. Claude Code, and the GitHub CLI (`gh`) signed in with access to your ISMS repo.
3. A Discord bot that can read your mailbox and team channels. Its token goes in one of: `~/.claude/channels/discord/.env` (line `DISCORD_BOT_TOKEN=...`), the `DISCORD_BOT_TOKEN` env var, or a file named by `DISCORD_ENV_FILE`. Never put the token in this folder.
4. `cp config.example.json config.local.json` and fill it in (it is git-ignored).
5. Optional: put your organisation's own rules in `private/*.md` (git-ignored). Every session reads them.
6. `npm test`, then:
```
claude
/manager
```

## Config (`config.local.json`)
| Key | Meaning |
|---|---|
| `owner.name` | Your name, as the board shows it. |
| `owner.github` | Your GitHub login. |
| `owner.discord` | Your Discord username; your own messages in the mailbox are skipped. |
| `owner.aliases` | Other names that mean you (`pending` on you is refused: it stays in progress). |
| `github.repo` | `owner/repo` of the ISMS repo; mailbox links to it name the issue, `post` writes to it. |
| `discord.guild` | Your server (guild) id. |
| `discord.mailbox` | `{ "id", "name" }` of your own mailbox channel. Each person sets their own. |
| `discord.channels` | Name -> channel id map that `discord <since> <name>` may read. |
| `discord.defaultChannel` | Channel read when none is named. |
| `timezone` | `{ "offsetHours", "label" }` for work-log headings. |

`ISO_MANAGER_CONFIG` can point at another config file.

## Commands
`node src/cli.js watch | backfill <ISO> | discord <ISO> [channel] | list [pending|done|all] | show <ref> | add <ref> "<title>" | todo <ref> "<text>" | start <ref> | pending <ref> <who> [note] | done <ref> | log <ref> "<text>" | post <ref> [--pending <who> <note>] [--done]`. Details in `CLAUDE.md`.

## What is never committed
`config.local.json`, `private/`, `data/` (thread text, may hold personal data), `worklog/`. To move to another computer, copy those privately.
