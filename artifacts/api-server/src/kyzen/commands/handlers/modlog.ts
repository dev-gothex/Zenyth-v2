import { AuditLogEvent, type Client, type Guild, type GuildMember, type Message, type PartialMessage } from "discord.js";
import { guildData, save } from "../../store";
import { formatDuration, parseChannel, parseDuration, parseInteger, parseMember, parseRole, parseUser } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bag = Record<string, any>;
export interface Case { id: number; type: string; userId: string; modId: string; reason: string; at: number; duration?: number }

export const caseList = (g: string): Case[] => ((guildData(g).cases ??= []) as Case[]);
export function logCase(ctx: Ctx, type: string, userId: string, reason: string, duration?: number): number {
  const list = caseList(ctx.guild.id);
  const id = (list.at(-1)?.id ?? 0) + 1;
  list.push({ id, type, userId, modId: ctx.member.id, reason: reason.slice(0, 500), at: Date.now(), duration });
  save();
  return id;
}

/* ---------- immunity + trusted staff ---------- */
const immune = (g: string): { users: string[]; roles: string[] } => ((guildData(g).immune ??= { users: [], roles: [] }) as never);
export function isImmune(guild: Guild, member: GuildMember): boolean {
  const i = immune(guild.id);
  return i.users.includes(member.id) || member.roles.cache.some((r) => i.roles.includes(r.id));
}

const staff = (g: string): Bag => (guildData(g).modstaff ??= { admins: [], mods: [], adminRole: undefined, modRole: undefined, modroles: [] });
const MOD_LEVEL = new Set(["mute", "unmute", "warn", "nickname", "timeout", "untimeout", "purge", "slowmode", "snipe", "silence", "unsilence", "modcases", "history", "scan"]);

/** True when trusted-staff settings grant this member access to a moderation command. */
export function hasBypass(guild: Guild, member: GuildMember, path: string): boolean {
  const s = staff(guild.id);
  const root = path.toLowerCase().split(" ")[0];
  const isAdmin = s.admins.includes(member.id) || (s.adminRole && member.roles.cache.has(s.adminRole));
  if (isAdmin) return true;
  const isMod = s.mods.includes(member.id) || (s.modRole && member.roles.cache.has(s.modRole));
  if (isMod && MOD_LEVEL.has(root)) return true;
  const managerKey = root === "unjail" ? "jail" : root;
  if (["jail", "chatban", "vcban"].includes(managerKey)) {
    const managers = ((guildData(guild.id)[managerKey]?.managers ?? []) as string[]);
    if (managers.includes(member.id) || member.roles.cache.some((r) => managers.includes(r.id))) return true;
  }
  return (s.modroles as { roleId: string; cmds: string[] }[]).some((m) => member.roles.cache.has(m.roleId) && (m.cmds.length === 0 || m.cmds.includes(root)));
}

/* ---------- snipes (in memory) ---------- */
const deleted = new Map<string, { content: string; authorId: string; at: number; image?: string }[]>();
const edited = new Map<string, { before: string; after: string; authorId: string; at: number }>();
const reactionsRemoved = new Map<string, { emoji: string; userId: string; messageUrl: string; at: number }>();
export const clearSnipes = (channelId: string) => { deleted.delete(channelId); edited.delete(channelId); reactionsRemoved.delete(channelId); };

const when = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;
const caseLine = (c: Case) => `\`#${c.id}\` **${c.type}** <@${c.userId}> by <@${c.modId}> ${when(c.at)}${c.reason ? ` - ${c.reason.slice(0, 60)}` : ""}`;

/** Validates and applies a warn-threshold action config. Used by the warn handler. */
export async function runWarnActions(ctx: Ctx, target: GuildMember, count: number): Promise<string | undefined> {
  const actions = (guildData(ctx.guild.id).warnActions ?? {}) as Record<string, { action: string; duration?: number }>;
  const a = actions[count];
  if (!a) return undefined;
  const reason = `Reached ${count} warnings`;
  if (a.action === "timeout" && target.moderatable) await target.timeout(Math.min(a.duration ?? 3_600_000, 28 * 86_400_000), reason);
  else if (a.action === "kick" && target.kickable) await target.kick(reason);
  else if (a.action === "ban" && target.bannable) await target.ban({ reason });
  else return undefined;
  logCase(ctx, a.action, target.id, reason, a.duration);
  return `Automatic action: **${a.action}** (${count} warnings).`;
}

const flagValue = (args: string[], names: string[]): string | undefined => {
  const i = args.findIndex((a) => names.includes(a.toLowerCase()));
  return i >= 0 ? args[i + 1] : undefined;
};

const ACTION_NAMES = ["timeout", "kick", "ban"];

export const MODLOG_HANDLERS: Record<string, Handler> = {
  modcases: async (ctx) => {
    const page = Math.max(1, parseInteger(ctx.args[0]) ?? 1);
    const all = [...caseList(ctx.guild.id)].reverse();
    const slice = all.slice((page - 1) * 10, page * 10);
    await ctx.reply(embed(slice.map(caseLine).join("\n") || "No cases.", `Cases (page ${page}/${Math.max(1, Math.ceil(all.length / 10))})`));
  },
  "modcases view": async (ctx) => {
    const c = caseList(ctx.guild.id).find((x) => x.id === parseInteger(ctx.args[0]));
    if (!c) throw new CommandError("I could not find that case.");
    await ctx.reply(embed([`**Type:** ${c.type}`, `**User:** <@${c.userId}>`, `**Moderator:** <@${c.modId}>`, `**When:** ${when(c.at)}`, c.duration ? `**Duration:** ${formatDuration(c.duration)}` : "", `**Reason:** ${c.reason || "None"}`].filter(Boolean).join("\n"), `Case #${c.id}`));
  },
  "modcases edit": async (ctx) => {
    const c = caseList(ctx.guild.id).find((x) => x.id === parseInteger(ctx.args[0]));
    const reason = ctx.args.slice(1).join(" ");
    if (!c || !reason) throw new CommandError("Use `modcases edit (case id) (new reason)`.");
    c.reason = reason.slice(0, 500);
    save();
    await ctx.ok(`Updated case #${c.id}.`);
  },
  history: async (ctx) => {
    const type = ctx.args[0].toLowerCase();
    const rows = caseList(ctx.guild.id).filter((c) => c.type === type).slice(-15).reverse().map(caseLine);
    await ctx.reply(embed(rows.join("\n") || `No ${type} cases.`, `History: ${type}`));
  },
  "history view": async (ctx) => MODLOG_HANDLERS["modcases view"](ctx),
  "history remove": async (ctx) => {
    const id = parseInteger(ctx.args[0]);
    const list = caseList(ctx.guild.id);
    if (!list.some((c) => c.id === id)) throw new CommandError("I could not find that case.");
    guildData(ctx.guild.id).cases = list.filter((c) => c.id !== id);
    save();
    await ctx.ok(`Removed case #${id}.`);
  },
  "history removeall": async (ctx) => {
    const user = await parseUser(ctx, ctx.args[0]);
    if (!user) throw new CommandError("I could not find that user.");
    const before = caseList(ctx.guild.id).length;
    guildData(ctx.guild.id).cases = caseList(ctx.guild.id).filter((c) => c.userId !== user.id);
    save();
    await ctx.ok(`Removed **${before - caseList(ctx.guild.id).length}** cases for ${user}.`);
  },
  modstats: async (ctx) => {
    const mod = await parseUser(ctx, ctx.args[0]);
    if (!mod) throw new CommandError("I could not find that moderator.");
    const counts: Record<string, number> = {};
    for (const c of caseList(ctx.guild.id)) if (c.modId === mod.id) counts[c.type] = (counts[c.type] ?? 0) + 1;
    await ctx.reply(embed(Object.entries(counts).map(([t, n]) => `**${t}:** ${n}`).join("\n") || "No actions.", `${mod.username}'s actions`));
  },
  scan: async (ctx) => {
    const user = await parseUser(ctx, ctx.args[0]);
    if (!user) throw new CommandError("I could not find that user.");
    const rows = caseList(ctx.guild.id).filter((c) => c.userId === user.id).slice(-15).reverse().map(caseLine);
    await ctx.reply(embed(rows.join("\n") || "No moderation history.", `${user.username}'s history`));
  },
  audit: async (ctx) => {
    const user = await parseUser(ctx, ctx.args[0]);
    const key = Object.keys(AuditLogEvent).find((k) => isNaN(Number(k)) && k.toLowerCase().includes(ctx.args[1].toLowerCase()));
    if (!user || !key) throw new CommandError("Use `audit (user) (action)` with an action like `ban`, `kick` or `roleupdate`.");
    const logs = await ctx.guild.fetchAuditLogs({ user, type: AuditLogEvent[key as keyof typeof AuditLogEvent] as never, limit: 10 }).catch(() => null);
    if (!logs) throw new CommandError("I need the View Audit Log permission.");
    const rows = [...logs.entries.values()].map((e) => `${when(e.createdTimestamp)} <@${e.targetId ?? "0"}> ${e.reason ? `- ${e.reason}` : ""}`);
    await ctx.reply(embed(rows.join("\n") || "No entries.", `${key} by ${user.username}`));
  },

  snipe: async (ctx) => {
    const last = deleted.get(ctx.message.channelId)?.at(-1);
    if (!last) throw new CommandError("There is nothing to snipe.");
    const card = embed(last.content || "(no text)", "Deleted message").setFooter({ text: `Author ${last.authorId}` });
    card.setDescription(`<@${last.authorId}> ${when(last.at)}\n${last.content || "(no text)"}`);
    if (last.image) card.setImage(last.image);
    await ctx.reply(card);
  },
  editsnipe: async (ctx) => {
    const e = edited.get(ctx.message.channelId);
    if (!e) throw new CommandError("There is nothing to snipe.");
    await ctx.reply(embed(`<@${e.authorId}> ${when(e.at)}\n**Before:** ${e.before || "(none)"}\n**After:** ${e.after || "(none)"}`, "Edited message"));
  },
  reactionsnipe: async (ctx) => {
    const r = reactionsRemoved.get(ctx.message.channelId);
    if (!r) throw new CommandError("There is nothing to snipe.");
    await ctx.reply(embed(`<@${r.userId}> removed ${r.emoji} ${when(r.at)}\n${r.messageUrl}`, "Removed reaction"));
  },
  clearsnipes: async (ctx) => { clearSnipes(ctx.message.channelId); await ctx.ok("Cleared the snipes in this channel."); },
  "autosnipe channel": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    if (!ch?.isTextBased()) throw new CommandError("I could not find that text channel.");
    guildData(ctx.guild.id).autosnipe = { channel: ch.id };
    save();
    await ctx.ok(`Deleted messages will be posted in ${ch}.`);
  },
  "autosnipe config": async (ctx) => { const a = guildData(ctx.guild.id).autosnipe; await ctx.ok(a?.channel ? `Sniped messages go to <#${a.channel}>.` : "Autosnipe is off."); },
  "autosnipe reset": async (ctx) => { delete guildData(ctx.guild.id).autosnipe; save(); await ctx.ok("Autosnipe is off."); },

  "immune add user": async (ctx) => { const m = await parseMember(ctx, ctx.args[0]); if (!m) throw new CommandError("I could not find that member."); const i = immune(ctx.guild.id); if (!i.users.includes(m.id)) i.users.push(m.id); save(); await ctx.ok(`${m} is now immune to moderation.`); },
  "immune add role": async (ctx) => { const r = parseRole(ctx, ctx.raw); if (!r) throw new CommandError("I could not find that role."); const i = immune(ctx.guild.id); if (!i.roles.includes(r.id)) i.roles.push(r.id); save(); await ctx.ok(`${r} is now immune to moderation.`); },
  "immune remove user": async (ctx) => { const m = await parseMember(ctx, ctx.args[0]); const i = immune(ctx.guild.id); i.users = i.users.filter((x) => x !== m?.id); save(); await ctx.ok("Removed from the immune list."); },
  "immune remove role": async (ctx) => { const r = parseRole(ctx, ctx.raw); const i = immune(ctx.guild.id); i.roles = i.roles.filter((x) => x !== r?.id); save(); await ctx.ok("Removed from the immune list."); },
  "immune list": async (ctx) => { const i = immune(ctx.guild.id); await ctx.reply(embed([...i.users.map((u) => `<@${u}>`), ...i.roles.map((r) => `<@&${r}>`)].join("\n") || "Nobody is immune.", "Immune list")); },

  "modrole add": async (ctx) => {
    const role = parseRole(ctx, ctx.args[0]);
    if (!role) throw new CommandError("I could not find that role.");
    const list = staff(ctx.guild.id).modroles as { roleId: string; cmds: string[] }[];
    const entry = list.find((m) => m.roleId === role.id);
    const cmds = ctx.args.slice(1).map((c) => c.toLowerCase());
    if (entry) entry.cmds = cmds; else list.push({ roleId: role.id, cmds });
    save();
    await ctx.ok(`${role} can now use ${cmds.length ? cmds.map((c) => `\`${c}\``).join(", ") : "all moderation commands"} without the usual permission.`);
  },
  "modrole remove": async (ctx) => {
    const role = parseRole(ctx, ctx.raw);
    const s = staff(ctx.guild.id);
    s.modroles = (s.modroles as { roleId: string }[]).filter((m) => m.roleId !== role?.id);
    save();
    await ctx.ok("Removed the mod role.");
  },
  "modsystem admin add": async (ctx) => { const m = await parseMember(ctx, ctx.args[0]); if (!m) throw new CommandError("I could not find that member."); const s = staff(ctx.guild.id); if (!s.admins.includes(m.id)) s.admins.push(m.id); save(); await ctx.ok(`${m} is now a trusted admin.`); },
  "modsystem admin remove": async (ctx) => { const m = await parseMember(ctx, ctx.args[0]); const s = staff(ctx.guild.id); s.admins = s.admins.filter((x: string) => x !== m?.id); save(); await ctx.ok("Removed the trusted admin."); },
  "modsystem admin list": async (ctx) => { await ctx.reply(embed(staff(ctx.guild.id).admins.map((x: string) => `<@${x}>`).join("\n") || "None.", "Trusted admins")); },
  "modsystem mod add": async (ctx) => { const m = await parseMember(ctx, ctx.args[0]); if (!m) throw new CommandError("I could not find that member."); const s = staff(ctx.guild.id); if (!s.mods.includes(m.id)) s.mods.push(m.id); save(); await ctx.ok(`${m} is now a trusted mod.`); },
  "modsystem mod remove": async (ctx) => { const m = await parseMember(ctx, ctx.args[0]); const s = staff(ctx.guild.id); s.mods = s.mods.filter((x: string) => x !== m?.id); save(); await ctx.ok("Removed the trusted mod."); },
  "modsystem mod list": async (ctx) => { await ctx.reply(embed(staff(ctx.guild.id).mods.map((x: string) => `<@${x}>`).join("\n") || "None.", "Trusted mods")); },
  "modsystem adminrole": async (ctx) => { const r = ctx.args[0] ? parseRole(ctx, ctx.raw) : null; if (ctx.args[0] && !r) throw new CommandError("I could not find that role."); staff(ctx.guild.id).adminRole = r?.id; save(); await ctx.ok(r ? `${r} grants admin-level bot access.` : "Cleared the admin role."); },
  "modsystem modrole": async (ctx) => { const r = ctx.args[0] ? parseRole(ctx, ctx.raw) : null; if (ctx.args[0] && !r) throw new CommandError("I could not find that role."); staff(ctx.guild.id).modRole = r?.id; save(); await ctx.ok(r ? `${r} grants moderator-level bot access.` : "Cleared the mod role."); },
  "modsystem stats": async (ctx) => MODLOG_HANDLERS.modstats(ctx.args[0] ? ctx : { ...ctx, args: [ctx.member.id] }),

  "warn expiry": async (ctx) => {
    const ms = ctx.args[0] ? parseDuration(ctx.args[0]) : null;
    if (ctx.args[0] && !ms) throw new CommandError("Use a duration such as `30d`.");
    guildData(ctx.guild.id).warnExpiry = ms ?? undefined;
    save();
    await ctx.ok(ms ? `Warnings expire after **${formatDuration(ms)}**.` : "Warnings no longer expire.");
  },
  "warn action list": async (ctx) => { await ctx.ok(`Available actions: ${ACTION_NAMES.join(", ")}.`); },
  "warn action add": async (ctx) => {
    const action = ctx.args[0].toLowerCase();
    const threshold = parseInteger(flagValue(ctx.args, ["--threshold", "-t"]) ?? ctx.args.find((a, i) => i > 0 && /^\d+$/.test(a)));
    const duration = parseDuration(flagValue(ctx.args, ["--duration", "-d"]) ?? ctx.args.find((a, i) => i > 0 && parseDuration(a) && !/^\d+$/.test(a)));
    if (!ACTION_NAMES.includes(action) || !threshold || threshold < 1) throw new CommandError("Use `warn action add (timeout|kick|ban) (threshold) [duration]`, for example `warn action add timeout 3 1h`.");
    const actions = ((guildData(ctx.guild.id).warnActions ??= {}) as Record<string, unknown>);
    actions[threshold] = { action, duration: duration ?? undefined };
    save();
    await ctx.ok(`At **${threshold}** warnings the member will receive a **${action}**${duration ? ` (${formatDuration(duration)})` : ""}.`);
  },
  "warn action config": async (ctx) => {
    const rows = Object.entries((guildData(ctx.guild.id).warnActions ?? {}) as Record<string, { action: string; duration?: number }>).map(([n, a]) => `**${n}** warnings -> ${a.action}${a.duration ? ` (${formatDuration(a.duration)})` : ""}`);
    await ctx.reply(embed(rows.join("\n") || "No automated actions.", "Warn actions"));
  },
  "warn action remove": async (ctx) => {
    const actions = (guildData(ctx.guild.id).warnActions ?? {}) as Record<string, unknown>;
    if (!(ctx.args[0] in actions)) throw new CommandError("No action is set at that threshold.");
    delete actions[ctx.args[0]];
    save();
    await ctx.ok("Removed the warn action.");
  },
};

export function startModLog(client: Client): void {
  client.on("messageDelete", (m: Message | PartialMessage) => {
    if (!m.inGuild() || m.author?.bot || (!m.content && m.attachments.size === 0)) return;
    const list = deleted.get(m.channelId) ?? [];
    const entry = { content: m.content ?? "", authorId: m.author?.id ?? "0", at: Date.now(), image: m.attachments.find((a) => a.contentType?.startsWith("image/"))?.url };
    deleted.set(m.channelId, [...list, entry].slice(-10));
    const auto = guildData(m.guild.id).autosnipe as { channel?: string } | undefined;
    const ch = auto?.channel ? m.guild.channels.cache.get(auto.channel) : undefined;
    if (ch?.isTextBased() && "send" in ch) void ch.send({ embeds: [embed(`<@${entry.authorId}> in <#${m.channelId}>\n${entry.content || "(attachment)"}`, "Deleted message")], allowedMentions: { parse: [] } }).catch(() => undefined);
  });
  client.on("messageUpdate", (before, after) => {
    if (!after.inGuild() || after.author?.bot || before.content === after.content) return;
    edited.set(after.channelId, { before: before.content ?? "", after: after.content ?? "", authorId: after.author?.id ?? "0", at: Date.now() });
  });
  client.on("messageReactionRemove", (r, u) => {
    if (u.bot || !r.message.guildId) return;
    reactionsRemoved.set(r.message.channelId, { emoji: r.emoji.toString(), userId: u.id, messageUrl: r.message.url, at: Date.now() });
  });
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      const expiry = guildData(guild.id).warnExpiry as number | undefined;
      if (!expiry) continue;
      const warnings = (guildData(guild.id).warnings ?? []) as { at: number }[];
      const kept = warnings.filter((w) => Date.now() - w.at < expiry);
      if (kept.length !== warnings.length) { guildData(guild.id).warnings = kept; save(); }
    }
  }, 3_600_000).unref();
}

export { UsageError };
