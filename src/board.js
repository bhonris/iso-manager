// The board: one row per issue, kept in data/state.json. Every change is load -> change -> save,
// so the watch process and status commands (separate processes) don't overwrite each other.
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['open', 'in_progress', 'pending', 'done'];
const RANK = { in_progress: 0, open: 1, pending: 2, done: 3 };
const KEEP_PINGS = 10;

// "903", "#903", "PR #903" -> "903"; "a81" -> "A81"; anything else is used as given.
export function idOf(ref) {
  const r = String(ref ?? '').trim();
  const n = /^(?:PR\s*)?#?(\d+)$/i.exec(r)?.[1];
  if (n) return n;
  return /^a\d+$/i.test(r) ? r.toUpperCase() : r;
}

export const refOf = (id) => (/^\d+$/.test(id) ? `#${id}` : id);

export class Board {
  constructor(file) {
    this.file = file;
  }

  load() {
    const empty = { cursor: null, mailbox: null, items: {} };
    if (!fs.existsSync(this.file)) return empty;
    return { ...empty, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
  }

  // Runs fn on the current state and saves it. Written to a temp file first, then renamed.
  change(fn) {
    const state = this.load();
    const out = fn(state);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    // On Windows the rename fails (EPERM/EBUSY) while another process has the file open to read
    // it; several subagents run `show` at once, so try again a few times before giving up.
    for (let attempt = 0; ; attempt++) {
      try {
        this.rename(tmp, this.file);
        return out;
      } catch (e) {
        if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  rename(from, to) {
    fs.renameSync(from, to);
  }

  get(ref) {
    return this.load().items[idOf(ref)];
  }

  // view: 'inbox' (open + in progress), 'pending', 'done' or 'all'.
  list(view = 'inbox') {
    const want = view === 'inbox' ? ['open', 'in_progress'] : view === 'all' ? STATUSES : [view];
    return Object.values(this.load().items)
      .filter((i) => want.includes(i.status))
      .sort((a, b) => RANK[a.status] - RANK[b.status] || String(b.at ?? '').localeCompare(String(a.at ?? '')));
  }

  // A new ask (a mailbox ping, or one added by hand) lands on its issue's row. A pending or done
  // row comes back to open and remembers what it was; a row being worked on is flagged as having news.
  ping(ask, now = new Date()) {
    return this.change((state) => {
      const id = idOf(ask.id);
      const prev = state.items[id];
      const entry = { at: ask.at, from: ask.from, url: ask.url, text: ask.text };
      const base = { id, title: ask.title, ask: ask.ask, from: ask.from, at: ask.at, url: ask.url, updated: now.toISOString() };
      if (!prev) {
        state.items[id] = { ...base, status: 'open', created: now.toISOString(), pings: [entry] };
      } else {
        const back = prev.status === 'pending' || prev.status === 'done';
        state.items[id] = {
          ...prev, ...base,
          status: back ? 'open' : prev.status,
          was: back ? (prev.status === 'pending' ? `pending on ${prev.waitingOn}` : 'done') : prev.was,
          waitingOn: back ? undefined : prev.waitingOn,
          waitingFor: back ? undefined : prev.waitingFor,
          news: prev.status === 'in_progress' ? true : prev.news,
          pings: [...(prev.pings ?? []), entry].slice(-KEEP_PINGS),
        };
      }
      return state.items[id];
    });
  }

  // Sets the status. waiting = { on, for } is kept only for 'pending'.
  setStatus(ref, status, { waiting, now = new Date() } = {}) {
    return this.change((state) => {
      const item = state.items[idOf(ref)];
      if (!item) return undefined;
      state.items[item.id] = {
        ...item, status, updated: now.toISOString(),
        news: status === 'in_progress' ? item.news : undefined,
        was: status === 'open' ? item.was : undefined,
        waitingOn: status === 'pending' ? waiting.on : undefined,
        waitingFor: status === 'pending' ? waiting.for || undefined : undefined,
        since: status === 'pending' ? now.toISOString() : undefined,
        doneAt: status === 'done' ? now.toISOString() : undefined,
      };
      return state.items[item.id];
    });
  }

  // The news flag is cleared once the item has been shown.
  seen(ref) {
    return this.change((state) => {
      const item = state.items[idOf(ref)];
      if (item?.news) item.news = undefined;
      return item;
    });
  }
}
