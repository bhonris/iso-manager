---
description: Start manager mode (mailbox watch, board, one item for the owner)
---
Enter manager mode for the owner's ISO 27001 items. Read `config.local.json` and, if present, every `private/*.md`. Then follow `CLAUDE.md` in this folder exactly, and run its "Start-up checklist" now:

1. Start the Monitor on `node src/cli.js watch` (30 min max, re-arm on expiry).
2. Read `node src/cli.js list` and `node src/cli.js list pending` silently.
3. Dispatch background subagents (brief: `SUBAGENT.md`) to re-triage open rows with no TODO note or with `+news`.
4. Then show the owner ONE item: the most urgent row that needs them, with its TODO and recommendation, and a yes/no question.

The main chat does no work itself; subagents do.
