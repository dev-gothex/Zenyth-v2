import type { GuildBasedChannel, GuildMember, Role, User } from "discord.js";
import type { Ctx } from "./types";

const ID = /^\d{15,22}$/;

function idFrom(token: string, kind: "@" | "@&" | "#"): string | null {
  const mention = token.match(new RegExp(`^<${kind}!?(\\d+)>$`));
  if (mention) return mention[1];
  return ID.test(token) ? token : null;
}

export async function parseMember(
  ctx: Ctx,
  token: string | undefined,
): Promise<GuildMember | null> {
  if (!token) return null;
  const id = idFrom(token, "@");
  if (id) return ctx.guild.members.fetch(id).catch(() => null);
  const needle = token.replace(/^@/, "").toLowerCase();
  const found = ctx.guild.members.cache.find(
    (m) =>
      m.user.username.toLowerCase() === needle ||
      m.displayName.toLowerCase() === needle,
  );
  return found ?? null;
}

export async function parseUser(
  ctx: Ctx,
  token: string | undefined,
): Promise<User | null> {
  if (!token) return null;
  const id = idFrom(token, "@");
  if (id) return ctx.client.users.fetch(id).catch(() => null);
  return (await parseMember(ctx, token))?.user ?? null;
}

export function parseRole(ctx: Ctx, token: string | undefined): Role | null {
  if (!token) return null;
  const id = idFrom(token, "@&");
  if (id) return ctx.guild.roles.cache.get(id) ?? null;
  const needle = token.replace(/^@/, "").toLowerCase();
  return (
    ctx.guild.roles.cache.find((r) => r.name.toLowerCase() === needle) ?? null
  );
}

export function parseChannel(
  ctx: Ctx,
  token: string | undefined,
): GuildBasedChannel | null {
  if (!token) return null;
  const id = idFrom(token, "#");
  if (id) return ctx.guild.channels.cache.get(id) ?? null;
  const needle = token.replace(/^#/, "").toLowerCase();
  return (
    ctx.guild.channels.cache.find((c) => c.name.toLowerCase() === needle) ??
    null
  );
}

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** "1h30m" -> milliseconds. Returns null when the token is not a duration. */
export function parseDuration(token: string | undefined): number | null {
  if (!token) return null;
  const parts = [...token.toLowerCase().matchAll(/(\d+)([smhdw])/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== token.toLowerCase()) {
    return null;
  }
  return parts.reduce((sum, [, n, u]) => sum + Number(n) * UNITS[u], 0);
}

export function formatDuration(ms: number): string {
  const units: [string, number][] = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ];
  const out: string[] = [];
  let rest = ms;
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) out.push(`${n}${label}`);
    rest -= n * size;
  }
  return out.join(" ") || "0s";
}

export function parseInteger(token: string | undefined): number | null {
  if (!token || !/^-?\d+$/.test(token)) return null;
  return Number(token);
}

export function mentionOf(kind: "user" | "role" | "channel", id: string): string {
  return kind === "user" ? `<@${id}>` : kind === "role" ? `<@&${id}>` : `<#${id}>`;
}
