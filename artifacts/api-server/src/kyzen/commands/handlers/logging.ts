import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction,
  type PartialGuildMember,
  type User,
} from "discord.js";
import { logger } from "../../../lib/logger";
import { guildData, save } from "../../store";
import { parseChannel, parseMember, parseRole } from "../args";
import { CommandError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bag = Record<string, any>;

/* ======================= categories ======================= */
export const CATEGORIES = [
  { key: "messages", label: "Messages", what: "message edits and deletions" },
  { key: "channels", label: "Channels & Threads", what: "channel and thread changes" },
  { key: "voice", label: "Voice & Stages", what: "voice joins, leaves and moves" },
  { key: "members", label: "Members", what: "joins, leaves, nicknames and avatars" },
  { key: "moderation", label: "Moderation", what: "bans, kicks and timeouts" },
  { key: "roles", label: "Roles", what: "role changes and role assignments" },
  { key: "server", label: "Server Settings", what: "server setting changes" },
  { key: "emojis", label: "Emojis", what: "emoji changes" },
  { key: "stickers", label: "Stickers", what: "sticker changes" },
  { key: "events", label: "Scheduled Events", what: "scheduled event changes" },
  { key: "automod", label: "AutoMod", what: "AutoMod rules and actions" },
  { key: "integrations", label: "Integrations & Webhooks", what: "integration and webhook changes" },
  { key: "invites", label: "Invites", what: "invite creation and deletion" },
  { key: "soundboard", label: "Soundboard", what: "soundboard changes" },
] as const;
type CatKey = (typeof CATEGORIES)[number]["key"];

const ALIASES: Record<string, CatKey> = {
  message: "messages", msg: "messages", channel: "channels", thread: "channels", threads: "channels", vc: "voice", stages: "voice",
  member: "members", join: "members", mod: "moderation", bans: "moderation", role: "roles", guild: "server", settings: "server",
  emoji: "emojis", sticker: "stickers", event: "events", scheduledevents: "events", webhooks: "integrations", webhook: "integrations",
  invite: "invites", sounds: "soundboard", sound: "soundboard",
};
const catByName = (name: string): CatKey | undefined => {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  return CATEGORIES.find((c) => c.key === n)?.key ?? ALIASES[n];
};
const labelOf = (key: CatKey) => CATEGORIES.find((c) => c.key === key)!.label;

const cfg = (g: string): Bag => {
  const bag = guildData(g);
  bag.logging ??= { channels: {}, ignore: { users: [], roles: [], channels: [] } };
  bag.logging.ignore ??= { users: [], roles: [], channels: [] };
  return bag.logging;
};

/* ======================= sending logs ======================= */
const GREEN = 0x57f287, RED = 0xed4245, YELLOW = 0xfee75c, BLUE = 0x5865f2, GREY = 0x99aab5;
interface Entry { title: string; lines?: (string | undefined | false | null)[]; color?: number; id?: string; thumb?: string; author?: { tag: string; displayAvatarURL(): string } | null }

function isIgnored(guild: Guild, who?: { userId?: string; roleIds?: string[]; channelId?: string }): boolean {
  const ig = cfg(guild.id).ignore as { users: string[]; roles: string[]; channels: string[] };
  if (who?.userId && ig.users.includes(who.userId)) return true;
  if (who?.channelId && ig.channels.includes(who.channelId)) return true;
  return Boolean(who?.roleIds?.some((r) => ig.roles.includes(r)));
}

async function emit(guild: Guild, cat: CatKey, e: Entry, who?: { userId?: string; roleIds?: string[]; channelId?: string }): Promise<void> {
  const channelId = cfg(guild.id).channels[cat] as string | undefined;
  if (!channelId || isIgnored(guild, who)) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  if (who?.channelId === channelId) return; // never log events about the log channel itself
  const card = new EmbedBuilder().setColor(e.color ?? GREY).setTitle(e.title).setTimestamp();
  const text = (e.lines ?? []).filter(Boolean).join("\n");
  if (text) card.setDescription(text.slice(0, 4000));
  try { if (e.author) card.setAuthor({ name: e.author.tag, iconURL: e.author.displayAvatarURL() }); } catch { if (e.author) card.setAuthor({ name: e.author.tag }); }
  try { if (e.thumb) card.setThumbnail(e.thumb); } catch { /* skip an unusable image */ }
  if (e.id) card.setFooter({ text: `ID: ${e.id}` });
  await channel.send({ embeds: [card], allowedMentions: { parse: [] } }).catch(() => undefined);
}

const ts = (ms?: number | null) => (ms ? `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)` : "Unknown");
const clip = (s: string | null | undefined, n = 900) => (s ? (s.length > n ? `${s.slice(0, n)}...` : s) : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Finds who performed an action by reading the audit log shortly after the event. */
async function executor(guild: Guild, type: AuditLogEvent, targetId?: string): Promise<{ user?: User; reason?: string } | undefined> {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return undefined;
  await sleep(1200);
  const logs = await guild.fetchAuditLogs({ type: type as never, limit: 6 }).catch(() => null);
  const hit = logs?.entries.find((x) => (!targetId || x.targetId === targetId) && Date.now() - x.createdTimestamp < 15_000);
  return hit ? { user: (hit.executor as User | null) ?? undefined, reason: hit.reason ?? undefined } : undefined;
}
const by = (x?: { user?: User }) => (x?.user ? `**By:** ${x.user} (${x.user.tag})` : undefined);

const PERMS = Object.entries(PermissionFlagsBits) as [string, bigint][];
const permNames = (bits: bigint) => PERMS.filter(([, v]) => (bits & v) === v).map(([k]) => k.replace(/([a-z])([A-Z])/g, "$1 $2")).join(", ");

/* ======================= listeners ======================= */
export function startLogging(client: Client): void {
  const on = (event: string, cat: CatKey, fn: (...a: any[]) => Promise<void> | void) =>
    client.on(event as never, (...args: any[]) => {
      void Promise.resolve(fn(...args)).catch((err: unknown) => logger.error({ err, event }, "Logging failed"));
    });

  /* messages */
  on(Events.MessageDelete, "messages", async (m: any) => {
    if (!m.guild || m.author?.bot) return;
    await emit(m.guild, "messages", {
      title: "Message deleted", color: RED, id: m.id, author: m.author ?? undefined,
      lines: [`**Author:** ${m.author ?? "Unknown (not cached)"}`, `**Channel:** <#${m.channelId}>`, m.content ? `**Content:**\n${clip(m.content)}` : m.partial ? "*The message was not cached, so its content is unknown.*" : undefined, m.attachments?.size ? `**Attachments:** ${m.attachments.size}` : undefined],
    }, { userId: m.author?.id, channelId: m.channelId, roleIds: m.member?.roles.cache.map((r: any) => r.id) });
  });
  on(Events.MessageUpdate, "messages", async (before: any, after: any) => {
    if (!after.guild || after.author?.bot || before.content === after.content || (!before.content && !after.content)) return;
    await emit(after.guild, "messages", {
      title: "Message edited", color: YELLOW, id: after.id, author: after.author ?? undefined,
      lines: [`**Author:** ${after.author ?? "Unknown"}`, `**Channel:** <#${after.channelId}> [Jump](${after.url})`, before.content ? `**Before:**\n${clip(before.content, 700)}` : "**Before:** *not cached*", `**After:**\n${clip(after.content, 700)}`],
    }, { userId: after.author?.id, channelId: after.channelId, roleIds: after.member?.roles.cache.map((r: any) => r.id) });
  });
  on(Events.MessageBulkDelete, "messages", async (messages: any, channel: any) => {
    await emit(channel.guild, "messages", { title: "Messages bulk deleted", color: RED, lines: [`**Channel:** ${channel}`, `**Count:** ${messages.size}`] }, { channelId: channel.id });
  });

  /* channels and threads */
  on(Events.ChannelCreate, "channels", async (ch: any) => {
    const who = await executor(ch.guild, AuditLogEvent.ChannelCreate, ch.id);
    await emit(ch.guild, "channels", { title: "Channel created", color: GREEN, id: ch.id, lines: [`**Channel:** ${ch} (${ch.name})`, `**Type:** ${ChannelType[ch.type]}`, ch.parent ? `**Category:** ${ch.parent.name}` : undefined, by(who)] });
  });
  on(Events.ChannelDelete, "channels", async (ch: any) => {
    if (!ch.guild) return;
    const who = await executor(ch.guild, AuditLogEvent.ChannelDelete, ch.id);
    await emit(ch.guild, "channels", { title: "Channel deleted", color: RED, id: ch.id, lines: [`**Name:** ${ch.name}`, `**Type:** ${ChannelType[ch.type]}`, by(who)] }, { channelId: ch.id });
  });
  on(Events.ChannelUpdate, "channels", async (a: any, b: any) => {
    if (!b.guild) return;
    const d: string[] = [];
    if (a.name !== b.name) d.push(`**Name:** ${a.name} -> ${b.name}`);
    if (a.topic !== b.topic) d.push(`**Topic:** ${clip(a.topic, 200) || "none"} -> ${clip(b.topic, 200) || "none"}`);
    if (a.nsfw !== b.nsfw) d.push(`**NSFW:** ${a.nsfw} -> ${b.nsfw}`);
    if (a.rateLimitPerUser !== b.rateLimitPerUser) d.push(`**Slowmode:** ${a.rateLimitPerUser ?? 0}s -> ${b.rateLimitPerUser ?? 0}s`);
    if (a.parentId !== b.parentId) d.push(`**Category:** ${a.parent?.name ?? "none"} -> ${b.parent?.name ?? "none"}`);
    if (a.permissionOverwrites?.cache.size !== b.permissionOverwrites?.cache.size) d.push("**Permission overwrites changed**");
    if (!d.length) return;
    const who = await executor(b.guild, AuditLogEvent.ChannelUpdate, b.id);
    await emit(b.guild, "channels", { title: "Channel updated", color: YELLOW, id: b.id, lines: [`**Channel:** ${b}`, ...d, by(who)] }, { channelId: b.id });
  });
  on(Events.ThreadCreate, "channels", async (t: any) => {
    await emit(t.guild, "channels", { title: "Thread created", color: GREEN, id: t.id, lines: [`**Thread:** ${t} (${t.name})`, `**Parent:** <#${t.parentId}>`, t.ownerId ? `**Owner:** <@${t.ownerId}>` : undefined] });
  });
  on(Events.ThreadDelete, "channels", async (t: any) => {
    await emit(t.guild, "channels", { title: "Thread deleted", color: RED, id: t.id, lines: [`**Name:** ${t.name}`, `**Parent:** <#${t.parentId}>`] });
  });
  on(Events.ThreadUpdate, "channels", async (a: any, b: any) => {
    const d: string[] = [];
    if (a.name !== b.name) d.push(`**Name:** ${a.name} -> ${b.name}`);
    if (a.archived !== b.archived) d.push(`**Archived:** ${a.archived} -> ${b.archived}`);
    if (a.locked !== b.locked) d.push(`**Locked:** ${a.locked} -> ${b.locked}`);
    if (d.length) await emit(b.guild, "channels", { title: "Thread updated", color: YELLOW, id: b.id, lines: [`**Thread:** ${b}`, ...d] });
  });

  /* voice */
  on(Events.VoiceStateUpdate, "voice", async (a: any, b: any) => {
    const m: GuildMember | null = b.member ?? a.member;
    if (!m || m.user.bot) return;
    const who = { userId: m.id, roleIds: m.roles.cache.map((r) => r.id) };
    if (!a.channelId && b.channelId) await emit(b.guild, "voice", { title: "Joined voice", color: GREEN, id: m.id, author: m.user, lines: [`${m} joined ${b.channel}`] }, who);
    else if (a.channelId && !b.channelId) await emit(a.guild, "voice", { title: "Left voice", color: RED, id: m.id, author: m.user, lines: [`${m} left ${a.channel}`] }, who);
    else if (a.channelId !== b.channelId) await emit(b.guild, "voice", { title: "Moved voice channel", color: BLUE, id: m.id, author: m.user, lines: [`${m} moved from ${a.channel} to ${b.channel}`] }, who);
    else if (a.serverMute !== b.serverMute) await emit(b.guild, "voice", { title: b.serverMute ? "Server muted" : "Server unmuted", color: YELLOW, id: m.id, author: m.user, lines: [`${m} in ${b.channel}`] }, who);
    else if (a.serverDeaf !== b.serverDeaf) await emit(b.guild, "voice", { title: b.serverDeaf ? "Server deafened" : "Server undeafened", color: YELLOW, id: m.id, author: m.user, lines: [`${m} in ${b.channel}`] }, who);
  });
  on(Events.StageInstanceCreate, "voice", async (s: any) => { await emit(s.guild, "voice", { title: "Stage started", color: GREEN, id: s.id, lines: [`**Topic:** ${s.topic}`, `**Channel:** <#${s.channelId}>`] }); });
  on(Events.StageInstanceDelete, "voice", async (s: any) => { await emit(s.guild, "voice", { title: "Stage ended", color: RED, id: s.id, lines: [`**Topic:** ${s.topic}`, `**Channel:** <#${s.channelId}>`] }); });

  /* members */
  on(Events.GuildMemberAdd, "members", async (m: GuildMember) => {
    await emit(m.guild, "members", { title: "Member joined", color: GREEN, id: m.id, author: m.user, thumb: m.user.displayAvatarURL(), lines: [`${m} (${m.user.tag})`, `**Account created:** ${ts(m.user.createdTimestamp)}`, `**Member count:** ${m.guild.memberCount}`] }, { userId: m.id });
  });
  on(Events.GuildMemberRemove, "members", async (m: GuildMember | PartialGuildMember) => {
    const roles = m.roles?.cache?.filter((r) => r.id !== m.guild.id).map((r) => r.toString()).join(" ");
    await emit(m.guild, "members", { title: "Member left", color: RED, id: m.id, author: m.user, thumb: m.user.displayAvatarURL(), lines: [`${m.user} (${m.user.tag})`, m.joinedTimestamp ? `**Joined:** ${ts(m.joinedTimestamp)}` : undefined, roles ? `**Roles:** ${roles}` : undefined] }, { userId: m.id });
    // kicks show up in the audit log shortly after the member leaves
    const who = await executor(m.guild, AuditLogEvent.MemberKick, m.id);
    if (who) await emit(m.guild, "moderation", { title: "Member kicked", color: RED, id: m.id, author: m.user, lines: [`**Member:** ${m.user} (${m.user.tag})`, by(who), who.reason ? `**Reason:** ${who.reason}` : undefined] }, { userId: m.id });
  });
  on(Events.GuildMemberUpdate, "members", async (a: GuildMember | PartialGuildMember, b: GuildMember) => {
    const who = { userId: b.id, roleIds: b.roles.cache.map((r) => r.id) };
    if (a.nickname !== b.nickname) await emit(b.guild, "members", { title: "Nickname changed", color: YELLOW, id: b.id, author: b.user, lines: [`${b}`, `**Before:** ${a.nickname ?? "none"}`, `**After:** ${b.nickname ?? "none"}`] }, who);
    if (a.communicationDisabledUntilTimestamp !== b.communicationDisabledUntilTimestamp) {
      const mod = await executor(b.guild, AuditLogEvent.MemberUpdate, b.id);
      const active = (b.communicationDisabledUntilTimestamp ?? 0) > Date.now();
      await emit(b.guild, "moderation", { title: active ? "Member timed out" : "Timeout removed", color: active ? RED : GREEN, id: b.id, author: b.user, lines: [`**Member:** ${b}`, active ? `**Until:** ${ts(b.communicationDisabledUntilTimestamp)}` : undefined, by(mod), mod?.reason ? `**Reason:** ${mod.reason}` : undefined] }, who);
    }
    if (a.roles) {
      const added = b.roles.cache.filter((r) => !a.roles.cache.has(r.id));
      const removed = a.roles.cache.filter((r) => !b.roles.cache.has(r.id));
      if (added.size || removed.size) {
        const mod = await executor(b.guild, AuditLogEvent.MemberRoleUpdate, b.id);
        await emit(b.guild, "roles", { title: "Member roles changed", color: BLUE, id: b.id, author: b.user, lines: [`**Member:** ${b}`, added.size ? `**Added:** ${added.map((r) => r.toString()).join(" ")}` : undefined, removed.size ? `**Removed:** ${removed.map((r) => r.toString()).join(" ")}` : undefined, by(mod)] }, who);
      }
    }
  });
  on(Events.UserUpdate, "members", async (a: any, b: User) => {
    const lines: string[] = [];
    if (a.username !== b.username) lines.push(`**Username:** ${a.username} -> ${b.username}`);
    if (a.avatar !== b.avatar) lines.push("**Avatar changed**");
    if (!lines.length) return;
    for (const guild of client.guilds.cache.values()) {
      if (guild.members.cache.has(b.id)) await emit(guild, "members", { title: "User updated", color: YELLOW, id: b.id, author: b, thumb: b.displayAvatarURL(), lines: [`${b}`, ...lines] }, { userId: b.id });
    }
  });

  /* moderation */
  on(Events.GuildBanAdd, "moderation", async (ban: any) => {
    const who = await executor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    await emit(ban.guild, "moderation", { title: "Member banned", color: RED, id: ban.user.id, author: ban.user, lines: [`**User:** ${ban.user} (${ban.user.tag})`, by(who), `**Reason:** ${ban.reason ?? who?.reason ?? "No reason provided"}`] }, { userId: ban.user.id });
  });
  on(Events.GuildBanRemove, "moderation", async (ban: any) => {
    const who = await executor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    await emit(ban.guild, "moderation", { title: "Member unbanned", color: GREEN, id: ban.user.id, author: ban.user, lines: [`**User:** ${ban.user} (${ban.user.tag})`, by(who)] }, { userId: ban.user.id });
  });

  /* roles */
  on(Events.GuildRoleCreate, "roles", async (r: any) => {
    const who = await executor(r.guild, AuditLogEvent.RoleCreate, r.id);
    await emit(r.guild, "roles", { title: "Role created", color: GREEN, id: r.id, lines: [`**Role:** ${r} (${r.name})`, by(who)] });
  });
  on(Events.GuildRoleDelete, "roles", async (r: any) => {
    const who = await executor(r.guild, AuditLogEvent.RoleDelete, r.id);
    await emit(r.guild, "roles", { title: "Role deleted", color: RED, id: r.id, lines: [`**Name:** ${r.name}`, by(who)] });
  });
  on(Events.GuildRoleUpdate, "roles", async (a: any, b: any) => {
    const d: string[] = [];
    if (a.name !== b.name) d.push(`**Name:** ${a.name} -> ${b.name}`);
    if (a.color !== b.color) d.push(`**Color:** ${a.hexColor} -> ${b.hexColor}`);
    if (a.hoist !== b.hoist) d.push(`**Hoisted:** ${a.hoist} -> ${b.hoist}`);
    if (a.mentionable !== b.mentionable) d.push(`**Mentionable:** ${a.mentionable} -> ${b.mentionable}`);
    const gained = BigInt(b.permissions.bitfield) & ~BigInt(a.permissions.bitfield);
    const lost = BigInt(a.permissions.bitfield) & ~BigInt(b.permissions.bitfield);
    if (gained !== 0n) d.push(`**Permissions added:** ${permNames(gained)}`);
    if (lost !== 0n) d.push(`**Permissions removed:** ${permNames(lost)}`);
    if (!d.length) return;
    const who = await executor(b.guild, AuditLogEvent.RoleUpdate, b.id);
    await emit(b.guild, "roles", { title: "Role updated", color: YELLOW, id: b.id, lines: [`**Role:** ${b}`, ...d, by(who)] });
  });

  /* server settings */
  on(Events.GuildUpdate, "server", async (a: Guild, b: Guild) => {
    const d: string[] = [];
    if (a.name !== b.name) d.push(`**Name:** ${a.name} -> ${b.name}`);
    if (a.icon !== b.icon) d.push("**Icon changed**");
    if (a.banner !== b.banner) d.push("**Banner changed**");
    if (a.splash !== b.splash) d.push("**Invite splash changed**");
    if (a.ownerId !== b.ownerId) d.push(`**Owner:** <@${a.ownerId}> -> <@${b.ownerId}>`);
    if (a.verificationLevel !== b.verificationLevel) d.push(`**Verification level:** ${a.verificationLevel} -> ${b.verificationLevel}`);
    if (a.afkChannelId !== b.afkChannelId) d.push(`**AFK channel:** ${a.afkChannelId ? `<#${a.afkChannelId}>` : "none"} -> ${b.afkChannelId ? `<#${b.afkChannelId}>` : "none"}`);
    if (a.afkTimeout !== b.afkTimeout) d.push(`**AFK timeout:** ${a.afkTimeout}s -> ${b.afkTimeout}s`);
    if (a.systemChannelId !== b.systemChannelId) d.push(`**System channel:** ${a.systemChannelId ? `<#${a.systemChannelId}>` : "none"} -> ${b.systemChannelId ? `<#${b.systemChannelId}>` : "none"}`);
    if (a.vanityURLCode !== b.vanityURLCode) d.push(`**Vanity URL:** ${a.vanityURLCode ?? "none"} -> ${b.vanityURLCode ?? "none"}`);
    if (a.description !== b.description) d.push("**Description changed**");
    if (!d.length) return;
    const who = await executor(b, AuditLogEvent.GuildUpdate);
    await emit(b, "server", { title: "Server updated", color: YELLOW, lines: [...d, by(who)] });
  });

  /* emojis and stickers */
  on(Events.GuildEmojiCreate, "emojis", async (e: any) => { const who = await executor(e.guild, AuditLogEvent.EmojiCreate, e.id); await emit(e.guild, "emojis", { title: "Emoji created", color: GREEN, id: e.id, thumb: e.imageURL(), lines: [`**Emoji:** ${e} (${e.name})`, by(who)] }); });
  on(Events.GuildEmojiDelete, "emojis", async (e: any) => { const who = await executor(e.guild, AuditLogEvent.EmojiDelete, e.id); await emit(e.guild, "emojis", { title: "Emoji deleted", color: RED, id: e.id, thumb: e.imageURL(), lines: [`**Name:** ${e.name}`, by(who)] }); });
  on(Events.GuildEmojiUpdate, "emojis", async (a: any, b: any) => { if (a.name !== b.name) await emit(b.guild, "emojis", { title: "Emoji renamed", color: YELLOW, id: b.id, thumb: b.imageURL(), lines: [`${b}`, `**Name:** ${a.name} -> ${b.name}`] }); });
  on(Events.GuildStickerCreate, "stickers", async (s: any) => { const who = await executor(s.guild, AuditLogEvent.StickerCreate, s.id); await emit(s.guild, "stickers", { title: "Sticker created", color: GREEN, id: s.id, thumb: s.url, lines: [`**Name:** ${s.name}`, by(who)] }); });
  on(Events.GuildStickerDelete, "stickers", async (s: any) => { const who = await executor(s.guild, AuditLogEvent.StickerDelete, s.id); await emit(s.guild, "stickers", { title: "Sticker deleted", color: RED, id: s.id, lines: [`**Name:** ${s.name}`, by(who)] }); });
  on(Events.GuildStickerUpdate, "stickers", async (a: any, b: any) => { if (a.name !== b.name) await emit(b.guild, "stickers", { title: "Sticker renamed", color: YELLOW, id: b.id, thumb: b.url, lines: [`**Name:** ${a.name} -> ${b.name}`] }); });

  /* scheduled events */
  on(Events.GuildScheduledEventCreate, "events", async (e: any) => { await emit(e.guild, "events", { title: "Event created", color: GREEN, id: e.id, lines: [`**Name:** ${e.name}`, `**Starts:** ${ts(e.scheduledStartTimestamp)}`, e.creator ? `**By:** ${e.creator}` : undefined] }); });
  on(Events.GuildScheduledEventDelete, "events", async (e: any) => { await emit(e.guild, "events", { title: "Event deleted", color: RED, id: e.id, lines: [`**Name:** ${e.name}`] }); });
  on(Events.GuildScheduledEventUpdate, "events", async (a: any, b: any) => {
    const d: string[] = [];
    if (a?.name !== b.name) d.push(`**Name:** ${a?.name} -> ${b.name}`);
    if (a?.status !== b.status) d.push(`**Status:** ${a?.status} -> ${b.status}`);
    if (a?.scheduledStartTimestamp !== b.scheduledStartTimestamp) d.push(`**Start:** ${ts(b.scheduledStartTimestamp)}`);
    if (d.length) await emit(b.guild, "events", { title: "Event updated", color: YELLOW, id: b.id, lines: [`**Event:** ${b.name}`, ...d] });
  });

  /* automod */
  on(Events.AutoModerationActionExecution, "automod", async (x: any) => {
    await emit(x.guild, "automod", { title: "AutoMod action", color: RED, id: x.ruleId, lines: [`**Rule:** ${x.ruleTriggerType}`, `**Member:** <@${x.userId}>`, x.channelId ? `**Channel:** <#${x.channelId}>` : undefined, x.matchedKeyword ? `**Matched:** ${x.matchedKeyword}` : undefined, x.content ? `**Content:** ${clip(x.content, 500)}` : undefined] }, { userId: x.userId, channelId: x.channelId ?? undefined });
  });
  on(Events.AutoModerationRuleCreate, "automod", async (r: any) => { await emit(r.guild, "automod", { title: "AutoMod rule created", color: GREEN, id: r.id, lines: [`**Name:** ${r.name}`, r.creatorId ? `**By:** <@${r.creatorId}>` : undefined] }); });
  on(Events.AutoModerationRuleDelete, "automod", async (r: any) => { await emit(r.guild, "automod", { title: "AutoMod rule deleted", color: RED, id: r.id, lines: [`**Name:** ${r.name}`] }); });
  on(Events.AutoModerationRuleUpdate, "automod", async (a: any, b: any) => { await emit(b.guild, "automod", { title: "AutoMod rule updated", color: YELLOW, id: b.id, lines: [`**Name:** ${b.name}`, a?.enabled !== b.enabled ? `**Enabled:** ${b.enabled}` : undefined] }); });

  /* integrations, webhooks, invites, soundboard */
  on(Events.GuildIntegrationsUpdate, "integrations", async (g: Guild) => { const who = await executor(g, AuditLogEvent.IntegrationUpdate); await emit(g, "integrations", { title: "Integrations updated", color: YELLOW, lines: [by(who)] }); });
  on(Events.WebhooksUpdate, "integrations", async (ch: any) => { const who = await executor(ch.guild, AuditLogEvent.WebhookCreate); await emit(ch.guild, "integrations", { title: "Webhooks updated", color: YELLOW, lines: [`**Channel:** ${ch}`, by(who)] }, { channelId: ch.id }); });
  on(Events.InviteCreate, "invites", async (i: any) => { await emit(i.guild, "invites", { title: "Invite created", color: GREEN, lines: [`**Code:** ${i.code}`, `**Channel:** ${i.channel}`, i.inviter ? `**By:** ${i.inviter}` : undefined, `**Max uses:** ${i.maxUses || "unlimited"}`, `**Expires:** ${i.maxAge ? `in ${Math.round(i.maxAge / 60)} minutes` : "never"}`] }); });
  on(Events.InviteDelete, "invites", async (i: any) => { await emit(i.guild, "invites", { title: "Invite deleted", color: RED, lines: [`**Code:** ${i.code}`, `**Channel:** ${i.channel}`] }); });
  on(Events.GuildSoundboardSoundCreate, "soundboard", async (s: any) => { await emit(s.guild, "soundboard", { title: "Sound created", color: GREEN, id: s.soundId, lines: [`**Name:** ${s.name}`, s.user ? `**By:** ${s.user}` : undefined] }); });
  on(Events.GuildSoundboardSoundDelete, "soundboard", async (s: any) => { await emit(s.guild, "soundboard", { title: "Sound deleted", color: RED, id: s.soundId, lines: [`**Name:** ${s.name}`] }); });
  on(Events.GuildSoundboardSoundUpdate, "soundboard", async (a: any, b: any) => { await emit(b.guild, "soundboard", { title: "Sound updated", color: YELLOW, id: b.soundId, lines: [`**Name:** ${a?.name ?? "?"} -> ${b.name}`] }); });

  client.on(Events.InteractionCreate, (i) => {
    void handlePanel(i).catch((err: unknown) => logger.error({ err }, "Logging panel failed"));
  });
}

/* ======================= panel (Components V2) ======================= */
const ACCENT = 0x9bb1ff;
const text = (s: string) => new TextDisplayBuilder().setContent(s);
const rule = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const trash = () => new ButtonBuilder().setCustomId("log:delete").setStyle(ButtonStyle.Secondary).setEmoji("\u{1F5D1}\uFE0F");
const btn = (id: string, label: string, style: ButtonStyle) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...b: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...b);

const maskOf = (keys: string[]) => keys.reduce((m, k) => m | (1 << CATEGORIES.findIndex((c) => c.key === k)), 0);
const keysOf = (mask: number): CatKey[] => CATEGORIES.filter((_, i) => mask & (1 << i)).map((c) => c.key);

function mainView(botName: string): ContainerBuilder {
  return new ContainerBuilder().setAccentColor(ACCENT)
    .addTextDisplayComponents(text(`# Logging Setup: ${botName}`))
    .addSeparatorComponents(rule())
    .addTextDisplayComponents(text("Select an action below to manage event channels and audit settings."))
    .addSeparatorComponents(rule())
    .addTextDisplayComponents(text("**Setup**\nConfigure logging categories and assign target channels for server events.\n**Configure**\nView all currently active event mappings and assigned channels.\n**Reset**\nReset and clear all configured logging events for this server."))
    .addSeparatorComponents(rule())
    .addActionRowComponents(row(btn("log:setup", "Setup", ButtonStyle.Primary), btn("log:config", "Configure", ButtonStyle.Secondary), btn("log:reset", "Reset", ButtonStyle.Danger)))
    .addActionRowComponents(row(trash()));
}

function categoriesView(): ContainerBuilder {
  const select = new StringSelectMenuBuilder().setCustomId("log:cats").setPlaceholder("Select Categories to configure...").setMinValues(1).setMaxValues(CATEGORIES.length)
    .addOptions(CATEGORIES.map((c) => ({ label: c.label, value: c.key, description: c.what.slice(0, 100) })));
  return new ContainerBuilder().setAccentColor(ACCENT)
    .addTextDisplayComponents(text("# Select Categories"), text("Choose one or more categories from the dropdown below to configure."))
    .addSeparatorComponents(rule())
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select))
    .addActionRowComponents(row(btn("log:back", "Back", ButtonStyle.Secondary), trash()));
}

function assignView(keys: CatKey[]): ContainerBuilder {
  const mask = maskOf(keys);
  const pick = new ChannelSelectMenuBuilder().setCustomId(`log:ch:${mask}`).setPlaceholder("Select a channel...").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1);
  return new ContainerBuilder().setAccentColor(ACCENT)
    .addTextDisplayComponents(text("# Assign Channel"), text(`Choose where logs for **${keys.map(labelOf).join(", ")}** are sent, or let me create the channels for you.`))
    .addSeparatorComponents(rule())
    .addActionRowComponents(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(pick))
    .addActionRowComponents(row(btn(`log:create:${mask}`, "Create Channels", ButtonStyle.Success), btn("log:setup", "Back", ButtonStyle.Secondary), trash()));
}

function configText(guild: Guild): string {
  const c = cfg(guild.id);
  const lines = CATEGORIES.map((cat) => `**${cat.label}:** ${c.channels[cat.key] ? `<#${c.channels[cat.key]}>` : "Not set"}`);
  const ig = c.ignore;
  lines.push(`\n**Ignored:** ${ig.users.length} users, ${ig.roles.length} roles, ${ig.channels.length} channels`);
  return lines.join("\n");
}
function configView(guild: Guild, note?: string): ContainerBuilder {
  const view = new ContainerBuilder().setAccentColor(ACCENT).addTextDisplayComponents(text(note ? `# ${note}` : "# Logging Configuration"));
  return view.addSeparatorComponents(rule()).addTextDisplayComponents(text(configText(guild))).addSeparatorComponents(rule())
    .addActionRowComponents(row(btn("log:back", "Back", ButtonStyle.Secondary), trash()));
}
function resetView(): ContainerBuilder {
  return new ContainerBuilder().setAccentColor(ACCENT)
    .addTextDisplayComponents(text("# Reset Logging?"), text("This clears every configured logging channel and the ignore list for this server. Your log channels are not deleted."))
    .addSeparatorComponents(rule())
    .addActionRowComponents(row(btn("log:reset:yes", "Confirm Reset", ButtonStyle.Danger), btn("log:back", "Cancel", ButtonStyle.Secondary)));
}

const V2: MessageFlags.IsComponentsV2 = MessageFlags.IsComponentsV2;

async function createChannels(guild: Guild, keys: CatKey[]): Promise<number> {
  const c = cfg(guild.id);
  let parent = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === "logs");
  if (!parent) parent = await guild.channels.create({ name: "Logs", type: ChannelType.GuildCategory, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }] });
  let n = 0;
  for (const key of keys) {
    const ch = await guild.channels.create({ name: `${key}-logs`, type: ChannelType.GuildText, parent: parent.id, reason: "Logging setup" }).catch(() => null);
    if (ch) { c.channels[key] = ch.id; n += 1; }
  }
  save();
  return n;
}

async function handlePanel(i: Interaction): Promise<void> {
  if (!("customId" in i) || !i.customId.startsWith("log:") || !i.guild) return;
  const member = i.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    if (i.isRepliable()) await i.reply({ content: "You need the **Manage Guild** permission to use this panel.", flags: MessageFlags.Ephemeral });
    return;
  }
  const id = i.customId;
  const guild = i.guild;
  const view = (c: ContainerBuilder) => ({ components: [c], flags: V2 });

  if (i.isButton()) {
    if (id === "log:delete") { await i.deferUpdate(); await i.message.delete().catch(() => undefined); return; }
    if (id === "log:back") return void (await i.update(view(mainView(guild.client.user.username))));
    if (id === "log:setup") return void (await i.update(view(categoriesView())));
    if (id === "log:config") return void (await i.update(view(configView(guild))));
    if (id === "log:reset") return void (await i.update(view(resetView())));
    if (id === "log:reset:yes") {
      guildData(guild.id).logging = { channels: {}, ignore: { users: [], roles: [], channels: [] } };
      save();
      return void (await i.update(view(configView(guild, "Logging Reset"))));
    }
    if (id.startsWith("log:create:")) {
      const keys = keysOf(Number(id.split(":")[2]));
      await i.deferUpdate();
      const n = await createChannels(guild, keys);
      await i.message.edit(view(configView(guild, `Created ${n} log channel${n === 1 ? "" : "s"}`)));
    }
    return;
  }
  if (i.isStringSelectMenu() && id === "log:cats") {
    return void (await i.update(view(assignView(i.values as CatKey[]))));
  }
  if (i.isChannelSelectMenu() && id.startsWith("log:ch:")) {
    const keys = keysOf(Number(id.split(":")[2]));
    const channelId = i.values[0];
    const c = cfg(guild.id);
    for (const key of keys) c.channels[key] = channelId;
    save();
    await i.update(view(configView(guild, "Logging Updated")));
  }
}

/* ======================= commands ======================= */
const need = (key?: string): CatKey => {
  const found = key ? catByName(key) : undefined;
  if (!found) throw new CommandError(`Unknown event. Choose one of: ${CATEGORIES.map((c) => `\`${c.key}\``).join(", ")}.`);
  return found;
};

const openPanel: Handler = async (ctx) => {
  await ctx.message.reply({ components: [mainView(ctx.client.user?.username ?? "Zenyth")], flags: V2, allowedMentions: { repliedUser: false } });
};

async function ignoreTarget(ctx: Ctx): Promise<{ kind: "users" | "roles" | "channels"; id: string }> {
  const token = ctx.args[0];
  const member = await parseMember(ctx, token);
  if (member) return { kind: "users", id: member.id };
  const role = parseRole(ctx, token);
  if (role) return { kind: "roles", id: role.id };
  const channel = parseChannel(ctx, token);
  if (channel) return { kind: "channels", id: channel.id };
  throw new CommandError("I could not find that user, role or channel.");
}

export const LOGGING_HANDLERS: Record<string, Handler> = {
  "logging panel": openPanel,
  "logging setup": async (ctx) => {
    if (!ctx.args[0]) return openPanel(ctx);
    const parent = parseChannel(ctx, ctx.args[0]);
    if (parent?.type !== ChannelType.GuildCategory) throw new CommandError("Give a category to create the log channels in, or run `logging setup` to open the panel.");
    const c = cfg(ctx.guild.id);
    let n = 0;
    for (const cat of CATEGORIES) {
      const ch = await ctx.guild.channels.create({ name: `${cat.key}-logs`, type: ChannelType.GuildText, parent: parent.id, reason: "Logging setup" }).catch(() => null);
      if (ch) { c.channels[cat.key] = ch.id; n += 1; }
    }
    save();
    await ctx.ok(`Created **${n}** log channels in **${parent.name}**.`);
  },
  "logging add": async (ctx) => {
    const key = need(ctx.args[0]);
    const ch = parseChannel(ctx, ctx.args[1]);
    if (!ch?.isTextBased() || !("send" in ch)) throw new CommandError("I could not find that text channel.");
    cfg(ctx.guild.id).channels[key] = ch.id;
    save();
    await ctx.ok(`**${labelOf(key)}** logs will be sent to ${ch}.`);
  },
  "logging add all": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    if (!ch?.isTextBased() || !("send" in ch)) throw new CommandError("I could not find that text channel.");
    const c = cfg(ctx.guild.id);
    for (const cat of CATEGORIES) c.channels[cat.key] = ch.id;
    save();
    await ctx.ok(`Every log category will be sent to ${ch}.`);
  },
  "logging remove": async (ctx) => {
    const key = need(ctx.args[0]);
    delete cfg(ctx.guild.id).channels[key];
    save();
    await ctx.ok(`Stopped logging **${labelOf(key)}**.`);
  },
  "logging remove all": async (ctx) => { cfg(ctx.guild.id).channels = {}; save(); await ctx.ok("Stopped all logging."); },
  "logging list": async (ctx) => { await ctx.reply(embed(configText(ctx.guild), "Logging channels")); },
  "logging ignore add": async (ctx) => {
    const t = await ignoreTarget(ctx);
    const list = cfg(ctx.guild.id).ignore[t.kind] as string[];
    if (!list.includes(t.id)) list.push(t.id);
    save();
    await ctx.ok("Added to the logging ignore list.");
  },
  "logging ignore remove": async (ctx) => {
    const t = await ignoreTarget(ctx);
    const ig = cfg(ctx.guild.id).ignore;
    ig[t.kind] = (ig[t.kind] as string[]).filter((x) => x !== t.id);
    save();
    await ctx.ok("Removed from the logging ignore list.");
  },
  "logging ignore list": async (ctx) => {
    const ig = cfg(ctx.guild.id).ignore as { users: string[]; roles: string[]; channels: string[] };
    const rows = [...ig.users.map((u) => `<@${u}>`), ...ig.roles.map((r) => `<@&${r}>`), ...ig.channels.map((c) => `<#${c}>`)];
    await ctx.reply(embed(rows.join("\n") || "Nothing is ignored.", "Logging ignore list"));
  },
};
