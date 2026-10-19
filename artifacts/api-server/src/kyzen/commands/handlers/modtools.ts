import {
  GuildDefaultMessageNotifications,
  MessageFlags,
  PermissionFlagsBits,
  GuildSystemChannelFlags,
  type Client,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type Role,
  type TextChannel,
} from "discord.js";
import { guildData, save } from "../../store";
import { parseChannel, parseInteger, parseMember, parseRole } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";
import { logCase } from "./modlog";

/* eslint-disable @typescript-eslint/no-explicit-any */
const textOf = (ctx: Ctx, token?: string): TextChannel => {
  const ch = token ? parseChannel(ctx, token) : ctx.message.channel;
  if (!ch || !ch.isTextBased() || !("bulkDelete" in ch)) throw new CommandError("I could not find that text channel.");
  return ch as TextChannel;
};
const amountOf = (token?: string): number => { const n = parseInteger(token); return n && n > 0 ? Math.min(n, 100) : 50; };
const TWO_WEEKS = 14 * 86_400_000;

/* ---------- purge variants ---------- */
async function purgeWhere(ctx: Ctx, filter: (m: Message) => boolean, amount: number, source?: Message[]): Promise<void> {
  const ch = textOf(ctx);
  const pool = source ?? [...(await ch.messages.fetch({ limit: 100, before: ctx.message.id })).values()];
  const picked = pool.filter(filter).filter((m) => Date.now() - m.createdTimestamp < TWO_WEEKS).slice(0, amount);
  const deleted = await ch.bulkDelete([...picked, ctx.message], true).catch(() => null);
  const n = Math.max(0, (deleted?.size ?? 1) - 1);
  const note = await ch.send({ embeds: [embed(`Deleted **${n}** message${n === 1 ? "" : "s"}.`)] });
  setTimeout(() => void note.delete().catch(() => undefined), 4000);
}
const IMAGE = (m: Message) => m.attachments.some((a) => a.contentType?.startsWith("image/")) || m.embeds.some((e) => e.image || e.thumbnail);
const purge = (filter: (m: Message) => boolean): Handler => (ctx) => purgeWhere(ctx, filter, amountOf(ctx.args[0]));

async function purgeRange(ctx: Ctx, opts: { after?: string; before?: string }, finish?: string): Promise<void> {
  const ch = textOf(ctx);
  const fetched = [...(await ch.messages.fetch({ limit: 100, ...opts } as { limit: number; after?: string; before?: string })).values()];
  await purgeWhere(ctx, (m) => (finish ? BigInt(m.id) < BigInt(finish) : true), 100, fetched);
}

/* ---------- roles ---------- */
function roleArg(ctx: Ctx, token = ctx.args[0]): Role {
  const r = parseRole(ctx, token);
  if (!r) throw new CommandError("I could not find that role.");
  return r;
}
function checkRole(ctx: Ctx, role: Role): void {
  if (role.managed || role.id === ctx.guild.id) throw new CommandError("That role cannot be assigned manually.");
  if (!role.editable) throw new CommandError("That role is above my highest role.");
  if (ctx.guild.ownerId !== ctx.member.id && role.position >= ctx.member.roles.highest.position) throw new CommandError("That role is equal to or above your highest role.");
}
async function targetMember(ctx: Ctx, token = ctx.args[0]): Promise<GuildMember> {
  const m = await parseMember(ctx, token);
  if (!m) throw new CommandError("I could not find that member.");
  return m;
}
async function bulk(ctx: Ctx, role: Role, pick: (m: GuildMember) => boolean, add: boolean): Promise<void> {
  checkRole(ctx, role);
  const members = [...(await ctx.guild.members.fetch()).values()].filter(pick);
  let n = 0;
  for (const m of members) {
    if (add === m.roles.cache.has(role.id)) continue;
    await (add ? m.roles.add(role, `Bulk by ${ctx.member.user.tag}`) : m.roles.remove(role, `Bulk by ${ctx.member.user.tag}`)).then(() => { n += 1; }).catch(() => undefined);
  }
  await ctx.ok(`${add ? "Added" : "Removed"} ${role} ${add ? "to" : "from"} **${n}** member${n === 1 ? "" : "s"}.`);
}
const hex = (token?: string): number => {
  if (!token || !/^#?[0-9a-f]{6}$/i.test(token)) throw new CommandError("Use a hex colour such as `#ff0000`.");
  return parseInt(token.replace("#", ""), 16);
};
export const backupRoles = (member: GuildMember): void => {
  const bag = (guildData(member.guild.id).roleBackup ??= {}) as Record<string, string[]>;
  bag[member.id] = member.roles.cache.filter((r) => r.id !== member.guild.id && !r.managed).map((r) => r.id);
  save();
};
const DANGEROUS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.MentionEveryone, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageNicknames];

const copyHandler = (parts: ("color" | "name" | "permissions")[]): Handler => async (ctx) => {
  const [src, dst] = [roleArg(ctx, ctx.args[0]), roleArg(ctx, ctx.args[1])];
  checkRole(ctx, dst);
  await dst.edit({ ...(parts.includes("color") ? { color: src.color } : {}), ...(parts.includes("name") ? { name: src.name } : {}), ...(parts.includes("permissions") ? { permissions: src.permissions } : {}) });
  await ctx.ok(`Copied ${parts.join(", ")} from ${src} to ${dst}.`);
};

/* ---------- channel visibility / silence ---------- */
type Target = GuildMember | Role;
async function targetOrRole(ctx: Ctx, token?: string): Promise<Target> {
  if (!token) return ctx.guild.roles.everyone;
  const t = (await parseMember(ctx, token)) ?? parseRole(ctx, token);
  if (!t) throw new CommandError("I could not find that member or role.");
  return t;
}
const channelsOf = (ctx: Ctx) => [...ctx.guild.channels.cache.values()].filter((c) => "permissionOverwrites" in c && !c.isThread()) as GuildBasedChannel[] as any[];

const visibility = (hide: boolean): Handler => async (ctx) => {
  const ch = parseChannel(ctx, ctx.args[0]) as any;
  if (!ch?.permissionOverwrites) throw new CommandError("I could not find that channel.");
  const target = await targetOrRole(ctx, ctx.args[1]);
  await ch.permissionOverwrites.edit(target.id, { ViewChannel: hide ? false : null });
  logCase(ctx, hide ? "hide" : "reveal", target.id, ctx.args.slice(2).join(" "));
  await ctx.ok(`${hide ? "Hid" : "Revealed"} ${ch} ${hide ? "from" : "to"} ${target}.`);
};
const visibilityAll = (hide: boolean): Handler => async (ctx) => {
  const target = await targetOrRole(ctx, ctx.args[0]);
  let n = 0;
  for (const ch of channelsOf(ctx)) await ch.permissionOverwrites.edit(target.id, { ViewChannel: hide ? false : null }).then(() => { n += 1; }).catch(() => undefined);
  await ctx.ok(`${hide ? "Hid" : "Revealed"} **${n}** channels ${hide ? "from" : "to"} ${target}.`);
};

const lockCfg = (g: string): { role?: string; ignore: string[] } => ((guildData(g).lockdown ??= { ignore: [] }) as never);
const lockAll = (lock: boolean): Handler => async (ctx) => {
  const cfg = lockCfg(ctx.guild.id);
  const role = cfg.role ?? ctx.guild.roles.everyone.id;
  let n = 0;
  for (const ch of channelsOf(ctx)) {
    if (!ch.isTextBased() || cfg.ignore.includes(ch.id)) continue;
    await ch.permissionOverwrites.edit(role, { SendMessages: lock ? false : null }).then(() => { n += 1; }).catch(() => undefined);
  }
  await ctx.ok(`${lock ? "Locked" : "Unlocked"} **${n}** channels.`);
};

const forced = (g: string): Record<string, string> => ((guildData(g).forcedNicks ??= {}) as never);

/* ---------- emojis ---------- */
const CUSTOM = /<(a?):(\w+):(\d+)>/g;
const emojiUrl = (id: string, animated: boolean) => `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}?size=128`;
async function addEmoji(ctx: Ctx, animated: boolean, id: string, name: string): Promise<boolean> {
  return ctx.guild.emojis.create({ attachment: emojiUrl(id, animated), name }).then(() => true).catch(() => false);
}

export const MODTOOLS_HANDLERS: Record<string, Handler> = {
  /* purge */
  "purge humans": purge((m) => !m.author.bot),
  "purge images": purge(IMAGE),
  "purge files": purge((m) => m.attachments.size > 0),
  "purge links": purge((m) => /https?:\/\//i.test(m.content)),
  "purge invites": purge((m) => /(discord\.gg|discord(app)?\.com\/invite)\//i.test(m.content)),
  "purge mentions": purge((m) => m.mentions.users.size > 0 || m.mentions.roles.size > 0 || m.mentions.everyone),
  "purge emojis": purge((m) => /<a?:\w+:\d+>/.test(m.content)),
  "purge stickers": purge((m) => m.stickers.size > 0),
  "purge system": purge((m) => m.system),
  "purge voice": purge((m) => m.flags.has(MessageFlags.IsVoiceMessage)),
  "purge webhooks": purge((m) => Boolean(m.webhookId)),
  "purge startswith": (ctx) => { const s = ctx.args[0].toLowerCase(); return purgeWhere(ctx, (m) => m.content.toLowerCase().startsWith(s), amountOf(ctx.args[1])); },
  "purge endswith": (ctx) => { const s = ctx.args[0].toLowerCase(); return purgeWhere(ctx, (m) => m.content.toLowerCase().endsWith(s), amountOf(ctx.args[1])); },
  "purge except": async (ctx) => { const m = await targetMember(ctx); return purgeWhere(ctx, (x) => x.author.id !== m.id, amountOf(ctx.args[1])); },
  "purge after": (ctx) => purgeRange(ctx, { after: ctx.args[0] }),
  "purge before": (ctx) => purgeRange(ctx, { before: ctx.args[0] }),
  "purge between": (ctx) => purgeRange(ctx, { after: ctx.args[0] }, ctx.args[1]),
  "purge reactions": async (ctx) => {
    const ch = textOf(ctx);
    const msgs = [...(await ch.messages.fetch({ limit: amountOf(ctx.args[0]) })).values()];
    for (const m of msgs) await m.reactions.removeAll().catch(() => undefined);
    await ctx.ok(`Removed reactions from **${msgs.length}** messages.`);
  },
  cleanup: (ctx) => purgeWhere(ctx, (m) => m.author.bot || m.content.startsWith(ctx.prefix), amountOf(ctx.args[0])),

  /* utility */
  newusers: async (ctx) => {
    const n = Math.min(parseInteger(ctx.args[0]) ?? 10, 25);
    const members = [...(await ctx.guild.members.fetch()).values()].sort((a, b) => (b.joinedTimestamp ?? 0) - (a.joinedTimestamp ?? 0)).slice(0, n);
    await ctx.reply(embed(members.map((m) => `${m} <t:${Math.floor((m.joinedTimestamp ?? 0) / 1000)}:R>`).join("\n"), "Newest members"));
  },
  nsfw: async (ctx) => {
    const ch = textOf(ctx, ctx.args[0]);
    await ch.setNSFW(!ch.nsfw);
    await ctx.ok(`${ch} is now ${ch.nsfw ? "NSFW" : "SFW"}.`);
  },
  picperms: async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]) as any;
    const m = await targetMember(ctx, ctx.args[1]);
    if (!ch?.permissionOverwrites) throw new CommandError("I could not find that channel.");
    const blocked = ch.permissionOverwrites.cache.get(m.id)?.deny.has("AttachFiles") ?? false;
    await ch.permissionOverwrites.edit(m.id, { AttachFiles: blocked ? null : false, EmbedLinks: blocked ? null : false });
    await ctx.ok(`${m} ${blocked ? "can send pictures again" : "can no longer send pictures"} in ${ch}.`);
  },
  "pin list": async (ctx) => {
    const ch = textOf(ctx);
    const pins = await (ch.messages as any).fetchPinned();
    const rows = [...pins.values()].slice(0, 15).map((m: Message) => `[${m.author.username}](${m.url}) ${m.content.slice(0, 60)}`);
    await ctx.reply(embed(rows.join("\n") || "No pinned messages.", "Pinned messages"));
  },

  /* voice moves */
  drag: async (ctx) => {
    const dest = ctx.member.voice.channel;
    if (!dest) throw new CommandError("Join a voice channel first.");
    let n = 0;
    for (const token of ctx.args) {
      const m = await parseMember(ctx, token);
      if (m?.voice.channel && (await m.voice.setChannel(dest).then(() => true).catch(() => false))) n += 1;
    }
    await ctx.ok(`Dragged **${n}** member${n === 1 ? "" : "s"} to ${dest}.`);
  },
  "drag all": async (ctx) => MODTOOLS_HANDLERS.moveall(ctx),
  moveall: async (ctx) => {
    const from = ctx.member.voice.channel;
    const to = parseChannel(ctx, ctx.args[0]);
    if (!from) throw new CommandError("Join a voice channel first.");
    if (!to?.isVoiceBased()) throw new CommandError("I could not find that voice channel.");
    let n = 0;
    for (const m of from.members.values()) if (await m.voice.setChannel(to).then(() => true).catch(() => false)) n += 1;
    await ctx.ok(`Moved **${n}** member${n === 1 ? "" : "s"} to ${to}.`);
  },

  /* visibility, silence, lockdown */
  "hide": async (ctx) => visibility(true)(ctx),
  reveal: visibility(false),
  "hide all": visibilityAll(true),
  "reveal all": visibilityAll(false),
  silence: async (ctx) => {
    const target = await targetOrRole(ctx, ctx.args[0]);
    const ch = parseChannel(ctx, ctx.args[1]) ?? ctx.message.channel as any;
    await (ch as any).permissionOverwrites.edit(target.id, { SendMessages: false, AddReactions: false, SendMessagesInThreads: false });
    logCase(ctx, "silence", target.id, "");
    await ctx.ok(`Silenced ${target} in ${ch}.`);
  },
  unsilence: async (ctx) => {
    const target = await targetOrRole(ctx, ctx.args[0]);
    const ch = parseChannel(ctx, ctx.args[1]) ?? ctx.message.channel as any;
    await (ch as any).permissionOverwrites.edit(target.id, { SendMessages: null, AddReactions: null, SendMessagesInThreads: null });
    await ctx.ok(`${target} can talk again in ${ch}.`);
  },
  "silence list": async (ctx) => {
    const ch = (parseChannel(ctx, ctx.args[0]) ?? ctx.message.channel) as any;
    const rows = [...ch.permissionOverwrites.cache.values()].filter((o: any) => o.id !== ctx.guild.id && o.deny.has("SendMessages")).map((o: any) => (o.type === 1 ? `<@${o.id}>` : `<@&${o.id}>`));
    await ctx.reply(embed(rows.join("\n") || "Nobody is silenced.", "Silenced"));
  },
  "lockdown all": lockAll(true),
  "unlockdown all": lockAll(false),
  "lockdown role": async (ctx) => { lockCfg(ctx.guild.id).role = roleArg(ctx).id; save(); await ctx.ok("Lockdown will target that role."); },
  "lockdown ignore": async (ctx) => { const ch = parseChannel(ctx, ctx.args[0]); if (!ch) throw new CommandError("I could not find that channel."); const c = lockCfg(ctx.guild.id); if (!c.ignore.includes(ch.id)) c.ignore.push(ch.id); save(); await ctx.ok(`${ch} is ignored by lockdowns.`); },
  "lockdown ignore remove": async (ctx) => { const ch = parseChannel(ctx, ctx.args[0]); const c = lockCfg(ctx.guild.id); c.ignore = c.ignore.filter((x) => x !== ch?.id); save(); await ctx.ok("Removed from the ignore list."); },
  "lockdown ignore list": async (ctx) => { await ctx.reply(embed(lockCfg(ctx.guild.id).ignore.map((id) => `<#${id}>`).join("\n") || "No ignored channels.", "Lockdown ignore list")); },

  /* server settings */
  "set name": async (ctx) => { await ctx.guild.setName(ctx.raw.slice(0, 100)); await ctx.ok("Updated the server name."); },
  "set icon": async (ctx) => { const url = ctx.message.attachments.first()?.url ?? ctx.args[0]; if (!url) throw new UsageError(); await ctx.guild.setIcon(url).catch(() => { throw new CommandError("I could not use that image."); }); await ctx.ok("Updated the server icon."); },
  "set banner": async (ctx) => { const url = ctx.message.attachments.first()?.url ?? ctx.args[0]; if (!url) throw new UsageError(); await ctx.guild.setBanner(url).catch(() => { throw new CommandError("I could not set the banner. The server needs a boost level that allows one."); }); await ctx.ok("Updated the server banner."); },
  "set splash": async (ctx) => { const url = ctx.message.attachments.first()?.url ?? ctx.args[0]; if (!url) throw new UsageError(); await ctx.guild.setSplash(url).catch(() => { throw new CommandError("I could not set the splash."); }); await ctx.ok("Updated the invite splash."); },
  "set notifications": async (ctx) => {
    const all = ctx.args[0].toLowerCase().startsWith("all");
    await ctx.guild.setDefaultMessageNotifications(all ? GuildDefaultMessageNotifications.AllMessages : GuildDefaultMessageNotifications.OnlyMentions);
    await ctx.ok(`Default notifications are now **${all ? "all messages" : "only mentions"}**.`);
  },
  "set system": async (ctx) => { const ch = textOf(ctx, ctx.args[0]); await ctx.guild.setSystemChannel(ch); await ctx.ok(`The system channel is now ${ch}.`); },
  "set system boost": async (ctx) => toggleFlag(ctx, GuildSystemChannelFlags.SuppressPremiumSubscriptions, "boost messages"),
  "set system welcome": async (ctx) => toggleFlag(ctx, GuildSystemChannelFlags.SuppressJoinNotifications, "welcome messages"),
  "set system welcome sticker": async (ctx) => toggleFlag(ctx, GuildSystemChannelFlags.SuppressJoinNotificationReplies, "welcome sticker replies"),

  /* roles */
  role: async (ctx) => {
    const m = await targetMember(ctx);
    const role = roleArg(ctx, ctx.args.slice(1).join(" "));
    checkRole(ctx, role);
    const has = m.roles.cache.has(role.id);
    await (has ? m.roles.remove(role) : m.roles.add(role));
    await ctx.ok(`${has ? "Removed" : "Added"} ${role} ${has ? "from" : "to"} ${m}.`);
  },
  "role add": async (ctx) => { const m = await targetMember(ctx); const role = roleArg(ctx, ctx.args.slice(1).join(" ")); checkRole(ctx, role); await m.roles.add(role); await ctx.ok(`Added ${role} to ${m}.`); },
  "role remove": async (ctx) => { const m = await targetMember(ctx); const role = roleArg(ctx, ctx.args.slice(1).join(" ")); checkRole(ctx, role); await m.roles.remove(role); await ctx.ok(`Removed ${role} from ${m}.`); },
  "role all": (ctx) => bulk(ctx, roleArg(ctx, ctx.raw), () => true, true),
  "role all remove": (ctx) => bulk(ctx, roleArg(ctx, ctx.raw), () => true, false),
  "role bots": (ctx) => bulk(ctx, roleArg(ctx, ctx.raw), (m) => m.user.bot, true),
  "role bots remove": (ctx) => bulk(ctx, roleArg(ctx, ctx.raw), (m) => m.user.bot, false),
  "role humans": (ctx) => bulk(ctx, roleArg(ctx, ctx.raw), (m) => !m.user.bot, true),
  "role humans remove": (ctx) => bulk(ctx, roleArg(ctx, ctx.raw), (m) => !m.user.bot, false),
  "role has": async (ctx) => { const [have, give] = [roleArg(ctx, ctx.args[0]), roleArg(ctx, ctx.args.slice(1).join(" "))]; await bulk(ctx, give, (m) => m.roles.cache.has(have.id), true); },
  "role has remove": async (ctx) => { const [have, take] = [roleArg(ctx, ctx.args[0]), roleArg(ctx, ctx.args.slice(1).join(" "))]; await bulk(ctx, take, (m) => m.roles.cache.has(have.id), false); },
  "role color": async (ctx) => { const r = roleArg(ctx); checkRole(ctx, r); await r.setColor(hex(ctx.args[1])); await ctx.ok(`Changed the colour of ${r}.`); },
  "role edit color": async (ctx) => MODTOOLS_HANDLERS["role color"](ctx),
  "role hoist": async (ctx) => { const r = roleArg(ctx); checkRole(ctx, r); await r.setHoist(!r.hoist); await ctx.ok(`${r} is ${r.hoist ? "now" : "no longer"} shown separately.`); },
  "role edit hoist": async (ctx) => MODTOOLS_HANDLERS["role hoist"](ctx),
  "role mentionable": async (ctx) => { const r = roleArg(ctx); checkRole(ctx, r); await r.setMentionable(!r.mentionable); await ctx.ok(`${r} is ${r.mentionable ? "now" : "no longer"} mentionable.`); },
  "role icon": async (ctx) => {
    const r = roleArg(ctx);
    checkRole(ctx, r);
    const url = ctx.message.attachments.first()?.url ?? ctx.args[1];
    await r.setIcon(url ?? null).catch(() => { throw new CommandError("I could not set the icon. The server needs boost level 2."); });
    await ctx.ok(url ? `Updated the icon of ${r}.` : `Removed the icon of ${r}.`);
  },
  "role create": async (ctx) => {
    const args = [...ctx.args];
    const color = /^#?[0-9a-f]{6}$/i.test(args[0] ?? "") ? hex(args.shift()) : undefined;
    const hoist = args[0]?.toLowerCase() === "hoist" ? (args.shift(), true) : false;
    const name = args.join(" ").slice(0, 100);
    if (!name) throw new UsageError();
    const role = await ctx.guild.roles.create({ name, color, hoist, reason: `Created by ${ctx.member.user.tag}` });
    await ctx.ok(`Created ${role}.`);
  },
  "role delete": async (ctx) => { const r = roleArg(ctx); checkRole(ctx, r); await r.delete(`Deleted by ${ctx.member.user.tag}`); await ctx.ok(`Deleted **${r.name}**.`); },
  "role copy": copyHandler(["color", "name", "permissions"]),
  "role copy all": copyHandler(["color", "name", "permissions"]),
  "role copy color": copyHandler(["color"]),
  "role copy name": copyHandler(["name"]),
  "role copy permissions": copyHandler(["permissions"]),
  "role transfer": async (ctx) => {
    const [from, to] = [await targetMember(ctx, ctx.args[0]), await targetMember(ctx, ctx.args[1])];
    const roles = from.roles.cache.filter((r) => r.id !== ctx.guild.id && !r.managed && r.editable && (ctx.guild.ownerId === ctx.member.id || r.position < ctx.member.roles.highest.position));
    await to.roles.add(roles);
    await from.roles.remove(roles);
    await ctx.ok(`Moved **${roles.size}** roles from ${from} to ${to}.`);
  },
  "role restore": async (ctx) => {
    const m = await targetMember(ctx);
    const saved = ((guildData(ctx.guild.id).roleBackup ?? {}) as Record<string, string[]>)[m.id];
    if (!saved?.length) throw new CommandError("I have no saved roles for that member.");
    const roles = saved.filter((id) => { const r = ctx.guild.roles.cache.get(id); return r?.editable && (ctx.guild.ownerId === ctx.member.id || r.position < ctx.member.roles.highest.position); });
    await m.roles.add(roles);
    await ctx.ok(`Restored **${roles.length}** roles to ${m}.`);
  },
  strip: async (ctx) => {
    const m = await targetMember(ctx);
    backupRoles(m);
    const risky = m.roles.cache.filter((r) => r.id !== ctx.guild.id && !r.managed && r.editable && DANGEROUS.some((p) => r.permissions.has(p)));
    await m.roles.remove(risky, ctx.args.slice(1).join(" ") || "Stripped");
    logCase(ctx, "strip", m.id, ctx.args.slice(1).join(" "));
    await ctx.ok(`Removed **${risky.size}** dangerous role${risky.size === 1 ? "" : "s"} from ${m}. Use \`${ctx.prefix}role restore\` to give them back.`);
  },

  /* nicknames */
  "forcenickname add": async (ctx) => { const m = await targetMember(ctx); const nick = ctx.args.slice(1).join(" ").slice(0, 32); if (!nick) throw new UsageError(); forced(ctx.guild.id)[m.id] = nick; save(); await m.setNickname(nick, "Forced nickname").catch(() => undefined); await ctx.ok(`${m} is locked to the nickname **${nick}**.`); },
  "forcenickname delete": async (ctx) => { const m = await targetMember(ctx); delete forced(ctx.guild.id)[m.id]; save(); await ctx.ok(`Removed the forced nickname from ${m}.`); },
  "forcenickname clear": async (ctx) => { guildData(ctx.guild.id).forcedNicks = {}; save(); await ctx.ok("Removed every forced nickname."); },
  "forcenickname show": async (ctx) => { await ctx.reply(embed(Object.entries(forced(ctx.guild.id)).map(([id, n]) => `<@${id}> -> ${n}`).join("\n") || "No forced nicknames.", "Forced nicknames")); },
  "nickname force": async (ctx) => { const m = await targetMember(ctx); const nick = ctx.args.slice(1).join(" ").slice(0, 32) || m.displayName; forced(ctx.guild.id)[m.id] = nick; save(); await m.setNickname(nick, "Forced nickname").catch(() => undefined); await ctx.ok(`${m} is locked to **${nick}**.`); },
  "nickname force cancel": async (ctx) => { const m = await targetMember(ctx); delete forced(ctx.guild.id)[m.id]; save(); await ctx.ok(`Released ${m}'s nickname.`); },

  /* threads */
  "thread add": async (ctx) => { const t = ctx.message.channel; if (!t.isThread()) throw new CommandError("Run this inside a thread."); const m = await targetMember(ctx); await t.members.add(m.id); await ctx.ok(`Added ${m} to the thread.`); },
  "thread remove": async (ctx) => { const t = parseChannel(ctx, ctx.args[0]); if (!t?.isThread()) throw new CommandError("I could not find that thread."); const m = await targetMember(ctx, ctx.args[1]); await t.members.remove(m.id); await ctx.ok(`Removed ${m} from the thread.`); },
  "thread lock": async (ctx) => { const t = parseChannel(ctx, ctx.args[0]); if (!t?.isThread()) throw new CommandError("I could not find that thread."); await t.setLocked(true, ctx.args.slice(1).join(" ")); await ctx.ok(`Locked ${t}.`); },
  "thread unlock": async (ctx) => { const t = parseChannel(ctx, ctx.args[0]); if (!t?.isThread()) throw new CommandError("I could not find that thread."); await t.setLocked(false, ctx.args.slice(1).join(" ")); await ctx.ok(`Unlocked ${t}.`); },
  "thread watch": async (ctx) => {
    const t = parseChannel(ctx, ctx.args[0]);
    if (!t?.isThread()) throw new CommandError("I could not find that thread.");
    const list = ((guildData(ctx.guild.id).watchedThreads ??= []) as string[]);
    const on = !list.includes(t.id);
    guildData(ctx.guild.id).watchedThreads = on ? [...list, t.id] : list.filter((x) => x !== t.id);
    save();
    if (on && t.archived) await t.setArchived(false).catch(() => undefined);
    await ctx.ok(on ? `${t} will be kept unarchived.` : `${t} is no longer watched.`);
  },
  "thread watch list": async (ctx) => { await ctx.reply(embed(((guildData(ctx.guild.id).watchedThreads ?? []) as string[]).map((id) => `<#${id}>`).join("\n") || "No watched threads.", "Watched threads")); },

  /* emojis */
  emoji: async (ctx) => {
    const m = CUSTOM.exec(ctx.args[0]);
    CUSTOM.lastIndex = 0;
    if (!m) throw new CommandError("Use a custom emoji from a server.");
    await ctx.reply(embed("").setImage(emojiUrl(m[3], m[1] === "a")).setDescription(`**${m[2]}** (${m[3]})`));
  },
  "emoji information": async (ctx) => {
    const m = [...ctx.args[0].matchAll(CUSTOM)][0];
    if (!m) throw new CommandError("Use a custom emoji from a server.");
    const known = ctx.guild.emojis.cache.get(m[3]);
    await ctx.reply(embed([`**Name:** ${m[2]}`, `**ID:** ${m[3]}`, `**Animated:** ${m[1] ? "Yes" : "No"}`, `**In this server:** ${known ? "Yes" : "No"}`].join("\n"), "Emoji").setThumbnail(emojiUrl(m[3], Boolean(m[1]))));
  },
  "emoji delete": async (ctx) => { const m = [...ctx.args[0].matchAll(CUSTOM)][0]; const e = m && ctx.guild.emojis.cache.get(m[3]); if (!e) throw new CommandError("That emoji is not in this server."); await e.delete(); await ctx.ok(`Deleted **${e.name}**.`); },
  "emoji rename": async (ctx) => { const m = [...ctx.args[0].matchAll(CUSTOM)][0]; const e = m && ctx.guild.emojis.cache.get(m[3]); if (!e) throw new CommandError("That emoji is not in this server."); await e.setName(ctx.args[1].slice(0, 32)); await ctx.ok(`Renamed the emoji to **${ctx.args[1]}**.`); },
  "emoji many": async (ctx) => addMany(ctx),
  "emoji add many": async (ctx) => addMany(ctx),
  "emoji add": async (ctx) => {
    const url = ctx.message.attachments.first()?.url ?? ctx.args.find((a) => /^https?:\/\//.test(a));
    const custom = [...ctx.raw.matchAll(CUSTOM)][0];
    const name = ctx.args.filter((a) => a !== url && !CUSTOM.test(a)).pop() ?? custom?.[2];
    CUSTOM.lastIndex = 0;
    if (!name) throw new UsageError();
    const ok = custom ? await addEmoji(ctx, Boolean(custom[1]), custom[3], name) : url ? await ctx.guild.emojis.create({ attachment: url, name }).then(() => true).catch(() => false) : false;
    if (!ok) throw new CommandError("I could not add that emoji. Check the image size and the server's emoji slots.");
    await ctx.ok(`Added the emoji **${name}**.`);
  },
  "emoji add reactions": async (ctx) => {
    const ch = textOf(ctx);
    const msg = await ch.messages.fetch(ctx.args[0]).catch(() => null);
    if (!msg) throw new CommandError("I could not find that message in this channel.");
    let n = 0;
    for (const r of msg.reactions.cache.values()) if (r.emoji.id && (await addEmoji(ctx, Boolean(r.emoji.animated), r.emoji.id, r.emoji.name ?? "emoji"))) n += 1;
    await ctx.ok(`Added **${n}** emojis.`);
  },
};

async function addMany(ctx: Ctx): Promise<void> {
  let n = 0;
  for (const m of ctx.raw.matchAll(CUSTOM)) if (await addEmoji(ctx, Boolean(m[1]), m[3], m[2])) n += 1;
  if (!n) throw new CommandError("I could not add any of those emojis.");
  await ctx.ok(`Added **${n}** emoji${n === 1 ? "" : "s"}.`);
}

async function toggleFlag(ctx: Ctx, flag: GuildSystemChannelFlags, label: string): Promise<void> {
  const next = ctx.guild.systemChannelFlags.bitfield ^ flag;
  await ctx.guild.setSystemChannelFlags(next);
  const suppressed = (next & flag) === flag;
  await ctx.ok(`Integrated ${label} are now ${suppressed ? "off" : "on"}.`);
}

export function startModTools(client: Client): void {
  client.on("guildMemberRemove", (m) => { if ("roles" in m && m.roles?.cache) backupRoles(m as GuildMember); });
  client.on("guildMemberUpdate", (_b, after) => {
    const nick = forced(after.guild.id)[after.id];
    if (nick && after.nickname !== nick) void after.setNickname(nick, "Forced nickname").catch(() => undefined);
  });
  client.on("threadUpdate", (_old, thread) => {
    const watched = (guildData(thread.guildId).watchedThreads ?? []) as string[];
    if (thread.archived && watched.includes(thread.id)) void thread.setArchived(false).catch(() => undefined);
  });
}
