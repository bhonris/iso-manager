# Operating reference

Overflow from `CLAUDE.md`. Organisation-specific reference (accounts, profiles, URLs, people) belongs in `private/`, not here.

## Subagent life cycle
1. Triage (read-only) per `SUBAGENT.md`; reply shape `ITEM / VERDICT / TODO / RECOMMEND / WAITING ON / DUE / WHY / NOT CHECKED`.
2. The manager sets the board: DONE or FYI -> `done`; WAITING -> `pending <who>`; TODO -> `todo <ref> "<text>"`, row stays open.
3. The owner answers -> manager sends `ACT: <exact action>` to the same agent.
4. Agent re-reads the thread, acts, confirms, runs `log`, replies with one line.

## Files
| Path | Tracked | What |
|---|---|---|
| `config.local.json` | no | Your identity, repo, Discord ids. Copy from `config.example.json`. |
| `private/*.md` | no | Your organisation's rules; every session reads them. |
| `data/state.json` | no | The board and the mailbox cursor. |
| `data/prep/<id>/comment.md` | no | A prepared comment waiting for approval. |
| `worklog/<n>.md` | no | Per-issue history, append-only. |

## Discord
The bot needs Read Message History on the mailbox and team channels. Channel names for `discord <since> <name>` are the keys of `discord.channels` in your config, plus the mailbox name.
