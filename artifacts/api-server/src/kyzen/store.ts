import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bag = Record<string, any>;
interface Data {
  guilds: Record<string, Bag>;
  users: Record<string, Bag>;
  global: Bag;
}

const DATA_DIR = process.env.ZENYTH_DATA_DIR ?? resolve(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "store.json");

function load(): Data {
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Data;
    return { guilds: parsed.guilds ?? {}, users: parsed.users ?? {}, global: parsed.global ?? {} };
  } catch {
    return { guilds: {}, users: {}, global: {} };
  }
}

const data = load();
let timer: NodeJS.Timeout | undefined;

function flush(): void {
  timer = undefined;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, DATA_FILE);
  } catch {
    /* persistence is best-effort; in-memory state still works */
  }
}

/** Per-guild bag. Mutate it, then call save(). */
export function guildData(guildId: string): Bag {
  return (data.guilds[guildId] ??= {});
}

/** Global per-user bag (economy, etc). Mutate it, then call save(). */
export function userData(userId: string): Bag {
  return (data.users[userId] ??= {});
}

/** Bot-wide state (blacklists, premium, staff, branding...). */
export function globalData(): Bag {
  return data.global;
}

/** Re-reads store.json from disk, replacing what is in memory. */
export function reloadStore(): { guilds: number; users: number } {
  if (timer) {
    clearTimeout(timer); // do not lose changes that were about to be written
    flush();
  }
  const fresh = load();
  data.guilds = fresh.guilds;
  data.users = fresh.users;
  data.global = fresh.global;
  return { guilds: Object.keys(data.guilds).length, users: Object.keys(data.users).length };
}

/** Writes the in-memory state to disk immediately. */
export function flushNow(): { guilds: number; users: number } {
  if (timer) clearTimeout(timer);
  flush();
  return { guilds: Object.keys(data.guilds).length, users: Object.keys(data.users).length };
}

export function allGuilds(): Record<string, Bag> {
  return data.guilds;
}

export function allUsers(): Record<string, Bag> {
  return data.users;
}

export function save(): void {
  if (timer) return;
  timer = setTimeout(flush, 250);
}

process.on("beforeExit", () => {
  if (timer) {
    clearTimeout(timer);
    flush();
  }
});
