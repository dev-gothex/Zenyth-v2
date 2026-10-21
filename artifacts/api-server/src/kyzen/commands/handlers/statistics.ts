import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type VoiceState,
} from "discord.js";
import { logger } from "../../../lib/logger";
import { allGuilds, guildData, save } from "../../store";
import { formatDuration, parseChannel, parseInteger, parseMember, parseRole } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { WHITE, embed } from "../ui";
import { renderTemplate } from "./render";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bag = Record<string, any>;

/* ======================= storage ======================= */
interface UserStats {
  m: number;
  ch: Record<string, number>;
  t: { text: number; sticker: number; gif: number; emoji: number };
  d: Record<string, number>;
  v: number;
  vch: Record<string, number>;
  vd: Record<string, number>;
  vs: { muted: number; deaf: number; stream: number; video: number; afk: number };
}

export const dayKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const addDays = (key: string, n: number) => dayKey(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000);
const lastDays = (n: number): string[] => Array.from({ length: n }, (_, i) => addDays(dayKey(), i - n + 1));

function root(guildId: string): Bag {
  const g = guildData(guildId);
  g.stats ??= {
    tracking: true,
    ignored: [],
    users: {},
    ev: { joins: {}, leaves: {}, chd: {}, vd: {}, st: {} },
    counters: {},
    streaks: { enabled: false, threshold: 1, unlock: 1, mode: "react", rewards: {}, users: {} },
  };
  return g.stats;
}
function user(guildId: string, userId: string): UserStats {
  const u = ((root(guildId).users[userId] ??= {}) as Partial<UserStats>);
  u.m ??= 0; u.ch ??= {}; u.t ??= { text: 0, sticker: 0, gif: 0, emoji: 0 }; u.d ??= {};
  u.v ??= 0; u.vch ??= {}; u.vd ??= {}; u.vs ??= { muted: 0, deaf: 0, stream: 0, video: 0, afk: 0 };
  return u as UserStats;
}
const bump = (rec: Record<string, number>, key: string, n = 1) => { rec[key] = (rec[key] ?? 0) + n; };
const sum = (rec: Record<string, number>, days: string[]) => days.reduce((n, d) => n + (rec[d] ?? 0), 0);
const num = (n: number) => n.toLocaleString("en-US");
const hours = (ms: number) => formatDuration(ms - (ms % 1000));

/* ======================= message tracking ======================= */
const EMOJI = /<a?:\w+:\d+>|\p{Extended_Pictographic}/u;
function messageKind(m: Message): keyof UserStats["t"] {
  if (m.stickers.size) return "sticker";
  if (/(tenor\.com|giphy\.com)/i.test(m.content) || m.attachments.some((a) => a.contentType === "image/gif") || m.embeds.some((e) => e.data.type === "gifv")) return "gif";
  if (EMOJI.test(m.content)) return "emoji";
  return "text";
}

function trackMessage(m: Message): void {
  if (!m.inGuild() || m.author.bot) return;
  const s = root(m.guild.id);
  if (!s.tracking || s.ignored.includes(m.channelId)) return;
  const u = user(m.guild.id, m.author.id);
  const today = dayKey();
  u.m += 1;
  bump(u.ch, m.channelId);
  bump(u.d, today);
  bump(u.t as any, messageKind(m));
  const chd = ((s.ev.chd[m.channelId] ??= {}) as Record<string, number>);
  bump(chd, today);
  save();
}

/* ======================= voice tracking ======================= */
interface Session { channelId: string; since: number; muted: boolean; deaf: boolean; stream: boolean; video: boolean; afk: boolean }
const sessions = new Map<string, Session>();

function flushSession(guildId: string, userId: string, now: number, restart: boolean): void {
  const key = `${guildId}:${userId}`;
  const s = sessions.get(key);
  if (!s) return;
  const elapsed = now - s.since;
  if (elapsed > 0 && !root(guildId).ignored.includes(s.channelId)) {
    const u = user(guildId, userId);
    u.v += elapsed;
    bump(u.vch, s.channelId, elapsed);
    bump(u.vd, dayKey(now), elapsed);
    bump(root(guildId).ev.vd, dayKey(now), elapsed);
    if (s.muted) u.vs.muted += elapsed;
    if (s.deaf) u.vs.deaf += elapsed;
    if (s.stream) u.vs.stream += elapsed;
    if (s.video) u.vs.video += elapsed;
    if (s.afk) u.vs.afk += elapsed;
    save();
  }
  if (restart) s.since = now;
  else sessions.delete(key);
}

function openSession(state: VoiceState, now: number): void {
  if (!state.channelId || state.member?.user.bot) return;
  sessions.set(`${state.guild.id}:${state.id}`, {
    channelId: state.channelId,
    since: now,
    muted: Boolean(state.selfMute || state.serverMute),
    deaf: Boolean(state.selfDeaf || state.serverDeaf),
    stream: Boolean(state.streaming),
    video: Boolean(state.selfVideo),
    afk: state.channelId === state.guild.afkChannelId,
  });
}

/* ======================= helpers for commands ======================= */
async function target(ctx: Ctx, token?: string): Promise<GuildMember> {
  if (!token) return ctx.member;
  const m = await parseMember(ctx, token);
  if (!m) throw new CommandError("I could not find that member.");
  return m;
}
const topEntries = (rec: Record<string, number>, n: number) => Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n);
const channelList = (rec: Record<string, number>, fmt: (v: number) => string, n = 3) => topEntries(rec, n).map(([id, v]) => `<#${id}> ${fmt(v)}`).join("\n") || "None yet";
const withLive = (guildId: string, userId: string): UserStats => {
  flushSession(guildId, userId, Date.now(), true); // include the time spent in the current session
  return user(guildId, userId);
};

async function messageOverview(ctx: Ctx, member: GuildMember, channelId?: string): Promise<void> {
  const u = user(ctx.guild.id, member.id);
  const today = dayKey();
  if (channelId) {
    await ctx.reply(embed(`${member} has sent **${num(u.ch[channelId] ?? 0)}** messages in <#${channelId}>.`, "Message statistics"));
    return;
  }
  const rank = Object.entries<UserStats>(root(ctx.guild.id).users).sort((a, b) => b[1].m - a[1].m).findIndex(([id]) => id === member.id) + 1;
  await ctx.reply(
    new EmbedBuilder().setColor(WHITE).setTitle(`${member.displayName}'s messages`).setThumbnail(member.displayAvatarURL()).setDescription(
      [
        `**Total:** ${num(u.m)}${rank ? ` (rank #${rank})` : ""}`,
        `**Today:** ${num(u.d[today] ?? 0)}`,
        `**Last 7 days:** ${num(sum(u.d, lastDays(7)))}`,
        `**Last 30 days:** ${num(sum(u.d, lastDays(30)))}`,
        `**Types:** text ${num(u.t.text)}, sticker ${num(u.t.sticker)}, gif ${num(u.t.gif)}, emoji ${num(u.t.emoji)}`,
        `\n**Top channels**\n${channelList(u.ch, num)}`,
      ].join("\n"),
    ),
  );
}

async function leaderboard(ctx: Ctx, title: string, score: (u: UserStats) => number, fmt: (n: number) => string): Promise<void> {
  const rows = Object.entries<UserStats>(root(ctx.guild.id).users)
    .map(([id, u]) => [id, score(u)] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, n], i) => `**${i + 1}.** <@${id}> - ${fmt(n)}`);
  await ctx.reply(embed(rows.join("\n") || "Nothing tracked yet.", title));
}

function serverOverview(guild: Guild): EmbedBuilder {
  const users = Object.values<UserStats>(root(guild.id).users);
  const msgs = users.reduce((n, u) => n + u.m, 0);
  const voice = users.reduce((n, u) => n + u.v, 0);
  const today = dayKey();
  const chTotals: Record<string, number> = {};
  for (const u of users) for (const [id, n] of Object.entries(u.ch)) bump(chTotals, id, n);
  return new EmbedBuilder().setColor(WHITE).setTitle(`${guild.name} statistics`).setThumbnail(guild.iconURL()).setDescription(
    [
      `**Members:** ${num(guild.memberCount)}`,
      `**Messages tracked:** ${num(msgs)} (today ${num(users.reduce((n, u) => n + (u.d[today] ?? 0), 0))})`,
      `**Voice time tracked:** ${hours(voice)}`,
      `**Tracking:** ${root(guild.id).tracking ? "On" : "Off"}`,
      `\n**Top channels**\n${channelList(chTotals, num, 5)}`,
    ].join("\n"),
  );
}

/* ======================= charts (QuickChart image URLs) ======================= */
function chartEmbed(title: string, type: "line" | "bar", labels: string[], sets: { label: string; data: number[]; color: string }[], footer?: string): EmbedBuilder {
  const config = {
    type,
    data: { labels, datasets: sets.map((s) => ({ label: s.label, data: s.data, borderColor: s.color, backgroundColor: type === "bar" ? s.color : `${s.color}33`, fill: false, borderWidth: 2 })) },
    options: {
      title: { display: true, text: title, fontColor: "#ffffff" },
      legend: { labels: { fontColor: "#ffffff" } },
      scales: { xAxes: [{ ticks: { fontColor: "#cccccc" } }], yAxes: [{ ticks: { fontColor: "#cccccc", beginAtZero: true } }] },
    },
  };
  const url = `https://quickchart.io/chart?bkg=%23111214&w=800&h=400&c=${encodeURIComponent(JSON.stringify(config))}`;
  const card = new EmbedBuilder().setColor(WHITE).setTitle(title).setImage(url.length < 2000 ? url : "https://quickchart.io/chart?c=%7B%7D");
  card.setFooter({ text: footer ?? "UTC days. Data builds up from when tracking started." });
  return card;
}
const shortLabels = (days: string[]) => days.map((d) => d.slice(5));
const DAYS = 14;

function joinsLeaves(guildId: string, wantJoins: boolean, wantLeaves: boolean): EmbedBuilder {
  const ev = root(guildId).ev;
  const days = lastDays(DAYS);
  const sets = [] as { label: string; data: number[]; color: string }[];
  if (wantJoins) sets.push({ label: "Joins", data: days.map((d) => ev.joins[d] ?? 0), color: "#57f287" });
  if (wantLeaves) sets.push({ label: "Leaves", data: days.map((d) => ev.leaves[d] ?? 0), color: "#ed4245" });
  const title = wantJoins && wantLeaves ? "Joins and leaves" : wantJoins ? "Member joins" : "Member leaves";
  return chartEmbed(title, "line", shortLabels(days), sets);
}

/* ======================= counters ======================= */
const COUNTER_TYPES: Record<string, string> = {
  announce: "Announcements", boosters: "Boosters", boosts: "Boosts", bots: "Bots", categories: "Categories",
  channels: "Channels", connected: "In voice", members: "Members", roles: "Roles", stage: "Stages",
  text: "Text channels", users: "Humans", voice: "Voice channels",
};
async function counterValue(guild: Guild, type: string): Promise<number> {
  const ch = guild.channels.cache;
  switch (type) {
    case "announce": return ch.filter((c) => c.type === ChannelType.GuildAnnouncement).size;
    case "boosts": return guild.premiumSubscriptionCount ?? 0;
    case "categories": return ch.filter((c) => c.type === ChannelType.GuildCategory).size;
    case "channels": return ch.filter((c) => !c.isThread()).size;
    case "connected": return guild.voiceStates.cache.filter((v) => Boolean(v.channelId)).size;
    case "members": return guild.memberCount;
    case "roles": return guild.roles.cache.size - 1;
    case "stage": return ch.filter((c) => c.type === ChannelType.GuildStageVoice).size;
    case "text": return ch.filter((c) => c.type === ChannelType.GuildText).size;
    case "voice": return ch.filter((c) => c.type === ChannelType.GuildVoice).size;
    default: {
      const members = await guild.members.fetch().catch(() => guild.members.cache);
      if (type === "bots") return members.filter((m) => m.user.bot).size;
      if (type === "users") return members.filter((m) => !m.user.bot).size;
      if (type === "boosters") return members.filter((m) => Boolean(m.premiumSince)).size;
      return 0;
    }
  }
}
const counterName = (type: string, value: number) => `${COUNTER_TYPES[type]}: ${num(value)}`;

async function refreshCounters(guild: Guild): Promise<void> {
  const counters = root(guild.id).counters as Record<string, { type: string }>;
  for (const [channelId, c] of Object.entries(counters)) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) { delete counters[channelId]; save(); continue; }
    const name = counterName(c.type, await counterValue(guild, c.type));
    if (channel.name !== name) await channel.setName(name, "Stat counter").catch(() => undefined);
  }
}

const createCounter = (type: string): Handler => async (ctx) => {
  const counters = root(ctx.guild.id).counters as Record<string, { type: string }>;
  if (Object.keys(counters).length >= 12) throw new CommandError("You can have up to 12 counters.");
  if (Object.values(counters).some((c) => c.type === type)) throw new CommandError("A counter of that type already exists.");
  const channel = await ctx.guild.channels.create({
    name: counterName(type, await counterValue(ctx.guild, type)),
    type: ChannelType.GuildVoice,
    permissionOverwrites: [{ id: ctx.guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }],
    reason: `Counter created by ${ctx.member.user.tag}`,
  });
  counters[channel.id] = { type };
  save();
  await ctx.ok(`Created the counter ${channel}. It updates every 10 minutes.`);
};

/* ======================= streaks ======================= */
interface StreakUser { streak: number; best: number; lastDone?: string; today: number; date?: string; tokens: number; claimed?: string; broken?: { streak: number; at: string } }
const sk = (g: string): Bag => root(g).streaks;
function streakUser(guildId: string, userId: string): StreakUser {
  const s = sk(guildId);
  const u = (s.users[userId] ??= { streak: 0, best: 0, today: 0, tokens: 0 }) as StreakUser;
  const today = dayKey();
  if (u.date !== today) { u.date = today; u.today = 0; }
  // a streak is broken when the last completed day is older than yesterday
  if (u.lastDone && u.streak > 0 && u.lastDone < addDays(today, -1)) {
    u.broken = { streak: u.streak, at: today };
    u.streak = 0;
  }
  return u;
}
const DEFAULT_STREAK_MESSAGE = "{user.mention} is on a **{streak}** day streak!";
const STREAK_MODES = ["react", "reply", "channel", "silent"];

async function onStreakMessage(m: Message): Promise<void> {
  if (!m.inGuild() || m.author.bot) return;
  const s = sk(m.guild.id);
  if (!s.enabled || root(m.guild.id).ignored.includes(m.channelId)) return;
  const u = streakUser(m.guild.id, m.author.id);
  u.today += 1;
  const today = dayKey();
  if (u.today >= s.threshold && u.lastDone !== today) {
    u.streak = u.lastDone === addDays(today, -1) ? u.streak + 1 : 1;
    u.lastDone = today;
    u.best = Math.max(u.best, u.streak);
    save();
    if (u.streak < s.unlock) return;
    const roleId = s.rewards[u.streak];
    if (roleId) await m.member?.roles.add(roleId, `Streak milestone ${u.streak}`).catch(() => undefined);
    const text = renderTemplate(s.message ?? DEFAULT_STREAK_MESSAGE, m.author, m.guild).replaceAll("{streak}", String(u.streak));
    if (s.mode === "react") await m.react("🔥").catch(() => undefined);
    else if (s.mode === "reply") await m.reply({ content: text, allowedMentions: { repliedUser: false } }).catch(() => undefined);
    else if (s.mode === "channel") {
      const ch = s.channel ? m.guild.channels.cache.get(s.channel) : m.channel;
      if (ch?.isTextBased() && "send" in ch) await ch.send({ content: text, allowedMentions: { users: [m.author.id] } }).catch(() => undefined);
    }
  } else save();
}

/* ======================= command handlers ======================= */
const toggleArg = (token?: string) => ["on", "true", "yes", "enable", "enabled"].includes((token ?? "").toLowerCase());
const needManageMessages = (ctx: Ctx) => {
  if (!ctx.member.permissions.has(PermissionFlagsBits.ManageMessages) && ctx.guild.ownerId !== ctx.member.id) {
    throw new CommandError("You need the **Manage Messages** permission to change another member's stats.");
  }
};

export const STATISTICS_HANDLERS: Record<string, Handler> = {
  /* messages */
  messages: async (ctx) => {
    let member: GuildMember = ctx.member;
    let channelId: string | undefined;
    for (const token of ctx.args) {
      const ch = parseChannel(ctx, token);
      if (ch && /^<#|^#/.test(token)) channelId = ch.id;
      else member = await target(ctx, token);
    }
    await messageOverview(ctx, member, channelId);
  },
  me: (ctx) => STATISTICS_HANDLERS.messages(ctx),
  user: (ctx) => STATISTICS_HANDLERS.messages(ctx),
  "info user": (ctx) => STATISTICS_HANDLERS.messages(ctx),
  "messages leaderboard": (ctx) => leaderboard(ctx, "Message leaderboard", (u) => u.m, num),
  "messages daily": (ctx) => leaderboard(ctx, "Today's message leaderboard", (u) => u.d[dayKey()] ?? 0, num),
  "messages type": async (ctx) => {
    const kind = ctx.args[0].toLowerCase() as keyof UserStats["t"];
    if (!["text", "sticker", "gif", "emoji"].includes(kind)) throw new CommandError("The type must be `text`, `sticker`, `gif` or `emoji`.");
    const member = await target(ctx, ctx.args[1]);
    const rank = Object.entries<UserStats>(root(ctx.guild.id).users).sort((a, b) => b[1].t[kind] - a[1].t[kind]).findIndex(([id]) => id === member.id) + 1;
    await ctx.reply(embed(`${member} has sent **${num(user(ctx.guild.id, member.id).t[kind])}** ${kind} messages${rank ? ` (rank #${rank})` : ""}.`, `${kind} messages`));
  },
  "messages add": async (ctx) => {
    const member = await target(ctx, ctx.args[0]);
    const n = parseInteger(ctx.args[1]);
    if (n === null || n < 0) throw new CommandError("The count must be zero or higher.");
    const u = user(ctx.guild.id, member.id);
    u.m += n;
    save();
    await ctx.ok(`Added **${num(n)}** messages to ${member}. Total: **${num(u.m)}**.`);
  },
  "messages remove": async (ctx) => {
    const member = await target(ctx, ctx.args[0]);
    const n = parseInteger(ctx.args[1]);
    if (n === null || n < 0) throw new CommandError("The count must be zero or higher.");
    const u = user(ctx.guild.id, member.id);
    u.m = Math.max(0, u.m - n);
    save();
    await ctx.ok(`Removed **${num(n)}** messages from ${member}. Total: **${num(u.m)}**.`);
  },
  "messages set": async (ctx) => {
    const member = await target(ctx, ctx.args[0]);
    const n = parseInteger(ctx.args[1]);
    if (n === null || n < 0) throw new CommandError("The count must be zero or higher.");
    user(ctx.guild.id, member.id).m = n;
    save();
    await ctx.ok(`Set ${member}'s total to **${num(n)}** messages.`);
  },
  "messages reset": async (ctx) => {
    const member = await target(ctx, ctx.args[0]);
    if (member.id !== ctx.member.id) needManageMessages(ctx);
    const u = user(ctx.guild.id, member.id);
    u.m = 0; u.ch = {}; u.d = {}; u.t = { text: 0, sticker: 0, gif: 0, emoji: 0 };
    save();
    await ctx.ok(`Reset ${member}'s message statistics.`);
  },
  "messages resetall": async (ctx) => {
    for (const u of Object.values<UserStats>(root(ctx.guild.id).users)) { u.m = 0; u.ch = {}; u.d = {}; u.t = { text: 0, sticker: 0, gif: 0, emoji: 0 }; }
    save();
    await ctx.ok("Reset everyone's message statistics.");
  },
  "messages tracking": async (ctx) => {
    const on = toggleArg(ctx.args[0]);
    if (!on && !["off", "false", "no", "disable", "disabled"].includes(ctx.args[0].toLowerCase())) throw new CommandError("Use `enable` or `disable`.");
    root(ctx.guild.id).tracking = on;
    save();
    await ctx.ok(`Message and voice tracking is now **${on ? "on" : "off"}**.`);
  },

  /* server overview, ignore list, member info */
  stats: async (ctx) => { await ctx.reply(serverOverview(ctx.guild)); },
  info: async (ctx) => { await ctx.reply(serverOverview(ctx.guild)); },
  "stats ignore": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    if (!ch) throw new CommandError("I could not find that channel.");
    const s = root(ctx.guild.id);
    if (!s.ignored.includes(ch.id)) s.ignored.push(ch.id);
    save();
    await ctx.ok(`${ch} is now ignored for message and voice tracking.`);
  },
  "stats unignore": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    const s = root(ctx.guild.id);
    if (!ch || !s.ignored.includes(ch.id)) throw new CommandError("That channel is not ignored.");
    s.ignored = s.ignored.filter((id: string) => id !== ch.id);
    save();
    await ctx.ok(`${ch} is tracked again.`);
  },
  "stats ignored": async (ctx) => { await ctx.reply(embed(root(ctx.guild.id).ignored.map((id: string) => `<#${id}>`).join("\n") || "No channels are ignored.", "Ignored channels")); },
  membercount: async (ctx) => {
    const members = await ctx.guild.members.fetch().catch(() => ctx.guild.members.cache);
    const bots = members.filter((m) => m.user.bot).size;
    await ctx.reply(embed(`**${num(ctx.guild.memberCount)}** members\n${num(ctx.guild.memberCount - bots)} humans, ${num(bots)} bots`, ctx.guild.name));
  },
  position: async (ctx) => {
    const member = await target(ctx, ctx.args[0]);
    const all = [...(await ctx.guild.members.fetch()).values()].sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));
    const pos = all.findIndex((m) => m.id === member.id) + 1;
    await ctx.ok(`${member} was member **#${num(pos)}** of ${num(all.length)} to join (<t:${Math.floor((member.joinedTimestamp ?? 0) / 1000)}:D>).`);
  },
  rankings: async (ctx) => {
    const users = Object.entries<UserStats>(root(ctx.guild.id).users);
    const top = (score: (u: UserStats) => number, fmt: (n: number) => string) =>
      users.map(([id, u]) => [id, score(u)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n], i) => `**${i + 1}.** <@${id}> ${fmt(n)}`).join("\n") || "None yet";
    for (const [id] of users) flushSession(ctx.guild.id, id, Date.now(), true);
    await ctx.reply(embed(`**Top messages**\n${top((u) => u.m, num)}\n\n**Top voice**\n${top((u) => u.v, hours)}`, "Rankings"));
  },
  globalstats: async (ctx) => {
    let msgs = 0, voice = 0;
    for (const bag of Object.values(allGuilds())) for (const u of Object.values<UserStats>(bag.stats?.users ?? {})) { msgs += u.m ?? 0; voice += u.v ?? 0; }
    const members = ctx.client.guilds.cache.reduce((n, g) => n + g.memberCount, 0);
    await ctx.reply(embed(`**Servers:** ${num(ctx.client.guilds.cache.size)}\n**Members:** ${num(members)}\n**Messages tracked:** ${num(msgs)}\n**Voice time tracked:** ${hours(voice)}`, "Global statistics"));
  },

  /* voice */
  vctime: async (ctx) => {
    let member: GuildMember = ctx.member;
    let channelId: string | undefined;
    for (const token of ctx.args) {
      const ch = parseChannel(ctx, token);
      if (ch && /^<#|^#/.test(token)) channelId = ch.id;
      else member = await target(ctx, token);
    }
    const u = withLive(ctx.guild.id, member.id);
    if (channelId) { await ctx.reply(embed(`${member} has spent **${hours(u.vch[channelId] ?? 0)}** in <#${channelId}>.`, "Voice time")); return; }
    await ctx.reply(embed([`**Total:** ${hours(u.v)}`, `**Today:** ${hours(u.vd[dayKey()] ?? 0)}`, `**Last 7 days:** ${hours(sum(u.vd, lastDays(7)))}`, `\n**Top channels**\n${channelList(u.vch, hours)}`].join("\n"), `${member.displayName}'s voice time`));
  },
  "vctime leaderboard": async (ctx) => { for (const id of Object.keys(root(ctx.guild.id).users)) flushSession(ctx.guild.id, id, Date.now(), true); await leaderboard(ctx, "Voice leaderboard", (u) => u.v, hours); },
  "vctime daily": async (ctx) => { for (const id of Object.keys(root(ctx.guild.id).users)) flushSession(ctx.guild.id, id, Date.now(), true); await leaderboard(ctx, "Today's voice leaderboard", (u) => u.vd[dayKey()] ?? 0, hours); },
  vcstats: async (ctx) => {
    const member = await target(ctx, ctx.args[0]);
    const u = withLive(ctx.guild.id, member.id);
    const v = member.voice;
    const now = v.channel
      ? [v.selfMute || v.serverMute ? "muted" : "unmuted", v.selfDeaf || v.serverDeaf ? "deafened" : "hearing", v.streaming ? "streaming" : null, v.selfVideo ? "camera on" : null, v.channelId === ctx.guild.afkChannelId ? "AFK channel" : null, v.channel.userLimit ? `limit ${v.channel.userLimit}` : null, v.channel.permissionsFor(ctx.guild.roles.everyone)?.has(PermissionFlagsBits.Connect) ? "unlocked" : "locked"].filter(Boolean).join(", ")
      : "not in voice";
    await ctx.reply(embed([`**Right now:** ${now}`, `**Total:** ${hours(u.v)}`, `**Muted:** ${hours(u.vs.muted)}`, `**Deafened:** ${hours(u.vs.deaf)}`, `**Streaming:** ${hours(u.vs.stream)}`, `**Camera:** ${hours(u.vs.video)}`, `**AFK channel:** ${hours(u.vs.afk)}`].join("\n"), `${member.displayName}'s voice stats`));
  },

  /* charts */
  "chart joins": async (ctx) => { await ctx.reply(joinsLeaves(ctx.guild.id, true, false)); },
  "chart leaves": async (ctx) => { await ctx.reply(joinsLeaves(ctx.guild.id, false, true)); },
  "chart combined": async (ctx) => { await ctx.reply(joinsLeaves(ctx.guild.id, true, true)); },
  "chart messages": async (ctx) => {
    const ch = ctx.args[0] ? parseChannel(ctx, ctx.args[0]) : ctx.message.channel;
    if (!ch) throw new CommandError("I could not find that channel.");
    const days = lastDays(DAYS);
    const chd = (root(ctx.guild.id).ev.chd[ch.id] ?? {}) as Record<string, number>;
    await ctx.reply(chartEmbed(`Messages in #${(ch as { name?: string }).name ?? ch.id}`, "bar", shortLabels(days), [{ label: "Messages", data: days.map((d) => chd[d] ?? 0), color: "#5865f2" }]));
  },
  "chart voice": async (ctx) => {
    for (const id of Object.keys(root(ctx.guild.id).users)) flushSession(ctx.guild.id, id, Date.now(), true);
    const days = lastDays(DAYS);
    const vd = root(ctx.guild.id).ev.vd as Record<string, number>;
    const contributors = Object.entries<UserStats>(root(ctx.guild.id).users).map(([id, u]) => [id, sum(u.vd, days)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n], i) => `${i + 1}. <@${id}> ${hours(n)}`).join("\n");
    const card = chartEmbed("Voice activity (hours)", "bar", shortLabels(days), [{ label: "Hours", data: days.map((d) => Math.round(((vd[d] ?? 0) / 3_600_000) * 10) / 10), color: "#57f287" }]);
    if (contributors) card.setDescription(`**Top contributors**\n${contributors}`);
    await ctx.reply(card);
  },
  "chart status": async (ctx) => {
    const days = lastDays(DAYS);
    const st = root(ctx.guild.id).ev.st as Record<string, { o: number; i: number; d: number; n: number }>;
    const avg = (k: "o" | "i" | "d") => days.map((d) => (st[d]?.n ? Math.round(st[d][k] / st[d].n) : 0));
    await ctx.reply(chartEmbed("Member status (daily average)", "line", shortLabels(days), [
      { label: "Online", data: avg("o"), color: "#57f287" },
      { label: "Idle", data: avg("i"), color: "#fee75c" },
      { label: "Do not disturb", data: avg("d"), color: "#ed4245" },
    ]));
  },

  /* counters */
  ...Object.fromEntries(Object.keys(COUNTER_TYPES).map((t) => [`counter create ${t}`, createCounter(t)])),
  "counter view": async (ctx) => {
    const rows = Object.entries<{ type: string }>(root(ctx.guild.id).counters).map(([id, c]) => `<#${id}> - ${c.type}`);
    await ctx.reply(embed(rows.join("\n") || "No counters yet.", "Counters"));
  },
  "counter delete": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    const counters = root(ctx.guild.id).counters as Bag;
    if (!ch || !counters[ch.id]) throw new CommandError("That channel is not a counter.");
    delete counters[ch.id];
    await ch.delete("Counter deleted").catch(() => undefined);
    save();
    await ctx.ok("Deleted the counter.");
  },
  "counter reset": async (ctx) => {
    const counters = root(ctx.guild.id).counters as Bag;
    const ids = Object.keys(counters);
    for (const id of ids) await ctx.guild.channels.cache.get(id)?.delete("Counters reset").catch(() => undefined);
    root(ctx.guild.id).counters = {};
    save();
    await ctx.ok(`Deleted **${ids.length}** counter${ids.length === 1 ? "" : "s"}.`);
  },

  /* streaks */
  streaks: async (ctx) => {
    const s = sk(ctx.guild.id);
    const u = streakUser(ctx.guild.id, ctx.member.id);
    const broken = u.broken && u.broken.at >= addDays(dayKey(), -7) ? `\n**Broken streak:** ${u.broken.streak} days (use \`${ctx.prefix}streaks restore\`)` : "";
    await ctx.reply(embed(`**Current streak:** ${u.streak} day${u.streak === 1 ? "" : "s"}\n**Best:** ${u.best}\n**Today:** ${u.today}/${s.threshold} messages\n**Restore tokens:** ${u.tokens}${broken}${s.enabled ? "" : "\n\nStreaks are currently disabled in this server."}`, `${ctx.member.displayName}'s streak`));
  },
  "streaks toggle": async (ctx) => { const s = sk(ctx.guild.id); s.enabled = !s.enabled; save(); await ctx.ok(`Streaks are now **${s.enabled ? "enabled" : "disabled"}**.`); },
  "streaks channel": async (ctx) => {
    const s = sk(ctx.guild.id);
    if (!ctx.args[0]) { s.channel = undefined; save(); await ctx.ok("Streak announcements will use the channel the member messaged in."); return; }
    const ch = parseChannel(ctx, ctx.args[0]);
    if (!ch?.isTextBased()) throw new CommandError("I could not find that text channel.");
    s.channel = ch.id; save();
    await ctx.ok(`Streak announcements will be sent in ${ch}.`);
  },
  "streaks message": async (ctx) => {
    sk(ctx.guild.id).message = ctx.raw.slice(0, 500);
    save();
    await ctx.ok("Updated the streak message. Use {user.mention}, {user.name} and {streak}.");
  },
  "streaks message reset": async (ctx) => { sk(ctx.guild.id).message = undefined; save(); await ctx.ok("Reset the streak message."); },
  "streaks message view": async (ctx) => { await ctx.ok(sk(ctx.guild.id).message ?? DEFAULT_STREAK_MESSAGE); },
  "streaks mode": async (ctx) => {
    const mode = ctx.args[0].toLowerCase();
    if (!STREAK_MODES.includes(mode)) throw new CommandError(`The mode must be one of: ${STREAK_MODES.join(", ")}.`);
    sk(ctx.guild.id).mode = mode; save();
    await ctx.ok(`Streak mode set to **${mode}**.`);
  },
  "streaks threshold": async (ctx) => {
    const n = parseInteger(ctx.args[0]);
    if (!n || n < 1 || n > 1000) throw new CommandError("The threshold must be between 1 and 1000 messages.");
    sk(ctx.guild.id).threshold = n; save();
    await ctx.ok(`Members need **${n}** message${n === 1 ? "" : "s"} per day to keep a streak.`);
  },
  "streaks unlock": async (ctx) => {
    const n = parseInteger(ctx.args[0]);
    if (!n || n < 1 || n > 365) throw new CommandError("The unlock requirement must be between 1 and 365 days.");
    sk(ctx.guild.id).unlock = n; save();
    await ctx.ok(`Streak messages and rewards start at **${n}** day${n === 1 ? "" : "s"}.`);
  },
  "streaks reward add": async (ctx) => {
    const days = parseInteger(ctx.args[0]);
    const role = parseRole(ctx, ctx.args.slice(1).join(" "));
    if (!days || days < 1 || !role) throw new UsageError();
    sk(ctx.guild.id).rewards[days] = role.id; save();
    await ctx.ok(`Members reaching a **${days}** day streak will receive ${role}.`);
  },
  "streaks reward remove": async (ctx) => {
    const days = parseInteger(ctx.args[0]);
    const rewards = sk(ctx.guild.id).rewards as Bag;
    if (!days || !(days in rewards)) throw new CommandError("No reward is set for that streak length.");
    delete rewards[days]; save();
    await ctx.ok("Removed the milestone role.");
  },
  "streaks reward": async (ctx) => {
    const rows = Object.entries<string>(sk(ctx.guild.id).rewards).sort((a, b) => Number(a[0]) - Number(b[0])).map(([d, r]) => `**${d}** days -> <@&${r}>`);
    await ctx.reply(embed(rows.join("\n") || "No milestone roles.", "Streak rewards"));
  },
  "streaks leaderboard": async (ctx) => {
    const s = sk(ctx.guild.id);
    const rows = Object.keys(s.users).map((id) => [id, streakUser(ctx.guild.id, id).streak] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n], i) => `**${i + 1}.** <@${id}> - ${n} day${n === 1 ? "" : "s"}`);
    await ctx.reply(embed(rows.join("\n") || "Nobody has a streak yet.", "Streak leaderboard"));
  },
  "streaks claim": async (ctx) => {
    const u = streakUser(ctx.guild.id, ctx.member.id);
    const month = dayKey().slice(0, 7);
    if (u.claimed === month) throw new CommandError("You already claimed this month's restore tokens.");
    u.claimed = month; u.tokens += 3; save();
    await ctx.ok(`You claimed **3** restore tokens. You now have **${u.tokens}**.`);
  },
  "streaks restore": async (ctx) => {
    const u = streakUser(ctx.guild.id, ctx.member.id);
    if (!u.broken || u.broken.at < addDays(dayKey(), -7)) throw new CommandError("You have no recently broken streak to restore.");
    if (u.tokens < 1) throw new CommandError(`You need a restore token. Use \`${ctx.prefix}streaks claim\` once a month.`);
    u.tokens -= 1;
    u.streak = u.broken.streak;
    u.lastDone = addDays(dayKey(), -1);
    u.best = Math.max(u.best, u.streak);
    delete u.broken;
    save();
    await ctx.ok(`Restored your **${u.streak}** day streak. Send your daily messages today to keep it.`);
  },
};

export function startStatistics(client: Client): void {
  const guard = (label: string, fn: () => Promise<void> | void) => {
    try { void Promise.resolve(fn()).catch((err: unknown) => logger.error({ err }, `${label} failed`)); } catch (err) { logger.error({ err }, `${label} failed`); }
  };

  client.on("messageCreate", (m) => guard("Message stats", () => { trackMessage(m); return onStreakMessage(m); }));
  client.on("guildMemberAdd", (m) => guard("Join stats", () => { bump(root(m.guild.id).ev.joins, dayKey()); save(); }));
  client.on("guildMemberRemove", (m) => guard("Leave stats", () => { bump(root(m.guild.id).ev.leaves, dayKey()); save(); }));

  client.on("voiceStateUpdate", (before, after) => guard("Voice stats", () => {
    if (after.member?.user.bot) return;
    const now = Date.now();
    flushSession(after.guild.id, after.id, now, false);
    openSession(after, now);
  }));
  client.once("clientReady", () => {
    for (const guild of client.guilds.cache.values()) for (const state of guild.voiceStates.cache.values()) openSession(state, Date.now());
  });

  setInterval(() => guard("Stats maintenance", async () => {
    const now = Date.now();
    for (const key of sessions.keys()) { const [g, u] = key.split(":"); flushSession(g, u, now, true); }
    // presence sample for the status chart
    for (const guild of client.guilds.cache.values()) {
      let o = 0, i = 0, d = 0;
      for (const p of guild.presences.cache.values()) { if (p.status === "online") o += 1; else if (p.status === "idle") i += 1; else if (p.status === "dnd") d += 1; }
      const st = root(guild.id).ev.st as Bag;
      const day = (st[dayKey()] ??= { o: 0, i: 0, d: 0, n: 0 });
      day.o += o; day.i += i; day.d += d; day.n += 1;
      await refreshCounters(guild);
    }
    // drop data older than 60 days
    const cutoff = addDays(dayKey(), -60);
    for (const bag of Object.values(allGuilds())) {
      const s = bag.stats as Bag | undefined;
      if (!s) continue;
      for (const rec of [s.ev.joins, s.ev.leaves, s.ev.vd, s.ev.st, ...Object.values<Bag>(s.ev.chd)]) for (const k of Object.keys(rec)) if (k < cutoff) delete rec[k];
      for (const u of Object.values<Bag>(s.users)) for (const rec of [u.d, u.vd]) for (const k of Object.keys(rec ?? {})) if (k < cutoff) delete rec[k];
    }
    save();
  }), 600_000).unref();
}
