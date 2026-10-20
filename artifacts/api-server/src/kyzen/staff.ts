import { globalData } from "./store";

export const HARD_OWNER = "1561255430838030338";
export const ENV_OWNERS = (process.env.ZENYTH_OWNER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Owners, developers, core team and admins, for permission checks and display. */
export function staffLists(): { owners: string[]; devs: string[]; core: string[]; admins: string[] } {
  const g = globalData();
  const s = (g.staff ??= { admins: [], devs: [], core: [] }) as { admins: string[]; devs: string[]; core: string[] };
  return { owners: [...new Set([HARD_OWNER, ...ENV_OWNERS])], devs: s.devs, core: s.core, admins: s.admins };
}
