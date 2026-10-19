import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bag = Record<string, any>;
interface Data {
  guilds: Record<string, Bag>;
  users: Record<string, Bag>;
}

const DATA_DIR = process.env.ZENYTH_DATA_DIR ?? resolve(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "store.json");

function load(): Data {
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Data;
    return { guilds: parsed.guilds ?? {}, users: parsed.users ?? {} };
  } catch {
    return { guilds: {}, users: {} };
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
