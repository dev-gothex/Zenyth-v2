import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type User,
} from "discord.js";
import { logger } from "../../../lib/logger";
import { allUsers, guildData, save, userData } from "../../store";
import { formatDuration, parseChannel, parseDuration, parseInteger, parseMember, parseRole } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { WHITE, embed } from "../ui";
import { renderTemplate } from "./render";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bag = Record<string, any>;
const sendable = (ch: GuildBasedChannel | null | undefined) => (ch?.isTextBased() && "send" in ch ? ch : null);
const guard = (label: string, fn: () => Promise<void>) => void fn().catch((err: unknown) => logger.error({ err }, `${label} failed`));
const stamp = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

/* ======================= LEVELING ======================= */
const lv = (g: string): Bag =>
  (guildData(g).level ??= { enabled: false, multiplier: 1, rewards: {}, ignore: [], xp: {}, message: "{user.mention} reached level **{level}**!" });
/** Total XP needed to reach level n. */
const xpFor = (n: number) => Math.round((5 / 6) * n * (2 * n * n + 27 * n + 91));
function levelOf(xp: number): number {
  let n = 0;
  while (xp >= xpFor(n + 1)) n += 1;
  return n;
}
const cooldown = new Map<string, number>();

async function textChannel(ctx: Ctx, token = ctx.args[0]) {
  const ch = sendable(parseChannel(ctx, token));
  if (!ch) throw new CommandError("I could not find that text channel.");
  return ch;
}

async function applyRewards(guild: Guild, userId: string, level: number): Promise<void> {
  const rewards = Object.entries<string>(lv(guild.id).rewards).filter(([need]) => Number(need) <= level);
  if (!rewards.length) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  for (const [, roleId] of rewards) await member?.roles.add(roleId, "Level reward").catch(() => undefined);
}

const LEVEL_HANDLERS: Record<string, Handler> = {
  level: async (ctx) => {
    const member = ctx.args[0] ? await parseMember(ctx, ctx.args[0]) : ctx.member;
    if (!member) throw new CommandError("I could not find that member.");
    const c = lv(ctx.guild.id);
    const xp: number = c.xp[member.id] ?? 0;
    const level = levelOf(xp);
    const rank = Object.entries<number>(c.xp).sort((a, b) => b[1] - a[1]).findIndex(([id]) => id === member.id) + 1;
    const into = xp - xpFor(level);
    const need = xpFor(level + 1) - xpFor(level);
    const filled = Math.round((into / need) * 10);
    await ctx.reply(embed(`**Level:** ${level}\n**XP:** ${into}/${need}\n\`[${"#".repeat(filled)}${"-".repeat(10 - filled)}]\`\n**Rank:** ${rank || "Unranked"}`, member.displayName));
  },
  "level enable": async (ctx) => { lv(ctx.guild.id).enabled = true; save(); await ctx.ok("Leveling is enabled."); },
  "level disable": async (ctx) => { lv(ctx.guild.id).enabled = false; save(); await ctx.ok("Leveling is disabled."); },
  "level toggle": async (ctx) => { const c = lv(ctx.guild.id); c.enabled = !c.enabled; save(); await ctx.ok(`Leveling is ${c.enabled ? "enabled" : "disabled"}.`); },
  "level channel": async (ctx) => {
    const c = lv(ctx.guild.id);
    c.channel = ctx.args[0] ? (await textChannel(ctx)).id : undefined;
    save();
    await ctx.ok(c.channel ? `Level-up messages go to <#${c.channel}>.` : "Level-up messages will be sent where the member levels up.");
  },
  "level message": async (ctx) => { lv(ctx.guild.id).message = ctx.raw.slice(0, 500); save(); await ctx.ok("Updated the level-up message. Use {user.mention} and {level}."); },
  "level message reset": async (ctx) => { lv(ctx.guild.id).message = "{user.mention} reached level **{level}**!"; save(); await ctx.ok("Reset the level-up message."); },
  "level message view": async (ctx) => { await ctx.ok(lv(ctx.guild.id).message); },
  "level message test": async (ctx) => { await ctx.ok(renderTemplate(lv(ctx.guild.id).message, ctx.member.user, ctx.guild).replaceAll("{level}", "5")); },
  "level multiplier": async (ctx) => {
    const n = Number(ctx.args[0]);
    if (!Number.isFinite(n) || n <= 0 || n > 10) throw new CommandError("The multiplier must be between 0 and 10.");
    lv(ctx.guild.id).multiplier = n;
    save();
    await ctx.ok(`XP multiplier set to **${n}x**.`);
  },
  "level booster": async (ctx) => {
    const n = Number(ctx.args[0]);
    if (!Number.isFinite(n) || n < 1 || n > 10) throw new CommandError("The booster multiplier must be between 1 and 10.");
    lv(ctx.guild.id).booster = n;
    save();
    await ctx.ok(`Server boosters earn **${n}x** XP.`);
  },
  "level leaderboard": async (ctx) => {
    const rows = Object.entries<number>(lv(ctx.guild.id).xp).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, xp], i) => `**${i + 1}.** <@${id}> - level ${levelOf(xp)} (${xp} XP)`);
    await ctx.reply(embed(rows.join("\n") || "Nobody has earned XP yet.", "Level leaderboard"));
  },
  "level set": async (ctx) => {
    const member = await parseMember(ctx, ctx.args[0]);
    const level = parseInteger(ctx.args[1]);
    if (!member || level === null || level < 0 || level > 500) throw new CommandError("Use `level set (member) (level)` with a level from 0 to 500.");
    lv(ctx.guild.id).xp[member.id] = xpFor(level);
    save();
    await applyRewards(ctx.guild, member.id, level);
    await ctx.ok(`Set ${member} to level **${level}**.`);
  },
  "level reset": async (ctx) => {
    const c = lv(ctx.guild.id);
    if (ctx.args[0]) {
      const member = await parseMember(ctx, ctx.args[0]);
      if (!member) throw new CommandError("I could not find that member.");
      delete c.xp[member.id];
      await ctx.ok(`Reset ${member}'s XP.`);
    } else {
      c.xp = {};
      await ctx.ok("Reset everyone's XP.");
    }
    save();
  },
  "level rewards add": async (ctx) => {
    const level = parseInteger(ctx.args[0]);
    const role = parseRole(ctx, ctx.args.slice(1).join(" "));
    if (!level || level < 1 || !role) throw new CommandError("Use `level rewards add (level) (role)`.");
    lv(ctx.guild.id).rewards[level] = role.id;
    save();
    await ctx.ok(`Members reaching level **${level}** will receive ${role}.`);
  },
  "level rewards remove": async (ctx) => {
    const role = parseRole(ctx, ctx.raw);
    const c = lv(ctx.guild.id);
    const key = Object.keys(c.rewards).find((k) => c.rewards[k] === role?.id);
    if (!key) throw new CommandError("That role is not a level reward.");
    delete c.rewards[key];
    save();
    await ctx.ok(`Removed ${role} from level rewards.`);
  },
  "level rewards list": async (ctx) => {
    const lines = Object.entries<string>(lv(ctx.guild.id).rewards).sort((a, b) => Number(a[0]) - Number(b[0])).map(([l, r]) => `Level **${l}** -> <@&${r}>`);
    await ctx.reply(embed(lines.join("\n") || "No level rewards.", "Level rewards"));
  },
  "level rewards reset": async (ctx) => { lv(ctx.guild.id).rewards = {}; save(); await ctx.ok("Removed all level rewards."); },
  "level rewards sync": async (ctx) => {
    let n = 0;
    for (const [id, xp] of Object.entries<number>(lv(ctx.guild.id).xp)) { await applyRewards(ctx.guild, id, levelOf(xp)); n += 1; }
    await ctx.ok(`Synced rewards for **${n}** members.`);
  },
  "level ignore add": async (ctx) => {
    const target = parseChannel(ctx, ctx.args[0])?.id ?? parseRole(ctx, ctx.args[0])?.id;
    if (!target) throw new CommandError("I could not find that channel or role.");
    const c = lv(ctx.guild.id);
    if (!c.ignore.includes(target)) c.ignore.push(target);
    save();
    await ctx.ok("Added to the ignore list.");
  },
  "level ignore remove": async (ctx) => {
    const target = parseChannel(ctx, ctx.args[0])?.id ?? parseRole(ctx, ctx.args[0])?.id;
    const c = lv(ctx.guild.id);
    c.ignore = c.ignore.filter((x: string) => x !== target);
    save();
    await ctx.ok("Removed from the ignore list.");
  },
  "level ignore list": async (ctx) => { await ctx.reply(embed(lv(ctx.guild.id).ignore.map((id: string) => `<#${id}> / <@&${id}>`).join("\n") || "Nothing is ignored.", "Level ignore list")); },
  "level config": async (ctx) => {
    const c = lv(ctx.guild.id);
    await ctx.reply(embed([`**Enabled:** ${c.enabled ? "Yes" : "No"}`, `**Multiplier:** ${c.multiplier}x`, `**Booster:** ${c.booster ?? 1}x`, `**Announce channel:** ${c.channel ? `<#${c.channel}>` : "Where they level up"}`, `**Rewards:** ${Object.keys(c.rewards).length}`].join("\n"), "Leveling"));
  },
};

async function onLevelMessage(m: Message): Promise<void> {
  if (!m.inGuild() || m.author.bot) return;
  const c = lv(m.guild.id);
  if (!c.enabled || c.ignore.includes(m.channelId) || m.member?.roles.cache.some((r) => c.ignore.includes(r.id))) return;
  const key = `${m.guild.id}:${m.author.id}`;
  if (Date.now() - (cooldown.get(key) ?? 0) < 60_000) return;
  cooldown.set(key, Date.now());
  const boost = m.member?.premiumSince ? (c.booster ?? 1) : 1;
  const before: number = c.xp[m.author.id] ?? 0;
  const after = before + Math.round((15 + Math.random() * 10) * c.multiplier * boost);
  c.xp[m.author.id] = after;
  save();
  const level = levelOf(after);
  if (level > levelOf(before)) {
    await applyRewards(m.guild, m.author.id, level);
    const ch = sendable(c.channel ? m.guild.channels.cache.get(c.channel) : m.channel);
    await ch?.send({ content: renderTemplate(c.message, m.author, m.guild).replaceAll("{level}", String(level)), allowedMentions: { users: [m.author.id] } }).catch(() => undefined);
  }
}

/* ======================= GIVEAWAYS ======================= */
const gw = (g: string): Record<string, Bag> => (guildData(g).giveaways ??= {});
const giveawayCard = (g: Bag, ended = false, winners: string[] = []) =>
  new EmbedBuilder().setColor(WHITE).setTitle(g.prize).setDescription(
    ended
      ? `**Winners:** ${winners.map((w) => `<@${w}>`).join(", ") || "Nobody entered"}\n**Host:** <@${g.hostId}>`
      : `Press the button to enter.\n**Ends:** ${stamp(g.endsAt)}\n**Winners:** ${g.winners}\n**Host:** <@${g.hostId}>\n**Entries:** ${g.entrants.length}`,
  );
const enterRow = (id: string, disabled = false) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`gw:enter:${id}`).setLabel("Enter").setStyle(ButtonStyle.Secondary).setDisabled(disabled));

function pickWinners(entrants: string[], n: number): string[] {
  const pool = [...entrants];
  const out: string[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

async function endGiveaway(guild: Guild, messageId: string, reroll = false, count?: number): Promise<string[]> {
  const g = gw(guild.id)[messageId];
  if (!g) throw new CommandError("I could not find that giveaway.");
  if (!reroll && g.ended) throw new CommandError("That giveaway already ended.");
  const winners = pickWinners(g.entrants, count ?? g.winners);
  g.ended = true;
  g.winnersList = winners;
  save();
  const channel = sendable(guild.channels.cache.get(g.channelId));
  const message = await channel?.messages.fetch(messageId).catch(() => null);
  await message?.edit({ embeds: [giveawayCard(g, true, winners)], components: [enterRow(messageId, true)] }).catch(() => undefined);
  await channel?.send({ content: winners.length ? `Congratulations ${winners.map((w) => `<@${w}>`).join(", ")}! You won **${g.prize}**.` : `Nobody entered the giveaway for **${g.prize}**.`, allowedMentions: { users: winners } }).catch(() => undefined);
  return winners;
}

async function refresh(ctx: Ctx, id: string): Promise<void> {
  const g = gw(ctx.guild.id)[id];
  const channel = g && sendable(ctx.guild.channels.cache.get(g.channelId));
  const message = channel ? await channel.messages.fetch(id).catch(() => null) : null;
  await message?.edit({ embeds: [giveawayCard(g)] }).catch(() => undefined);
}
const needGiveaway = (ctx: Ctx, id = ctx.args[0]): Bag => {
  const g = gw(ctx.guild.id)[id];
  if (!g) throw new CommandError("I could not find that giveaway.");
  return g;
};

const GIVEAWAY_HANDLERS: Record<string, Handler> = {
  "giveaway create": async (ctx) => {
    const ch = await textChannel(ctx);
    const ms = parseDuration(ctx.args[1]);
    const winners = parseInteger(ctx.args[2]?.replace(/w$/i, ""));
    const prize = ctx.args.slice(3).filter((a) => !a.startsWith("--")).join(" ");
    if (!ms || !winners || winners < 1 || winners > 20 || !prize) throw new UsageError();
    const g: Bag = { channelId: ch.id, prize, winners, endsAt: Date.now() + ms, hostId: ctx.member.id, entrants: [], ended: false };
    const posted = await ch.send({ embeds: [giveawayCard(g)], components: [enterRow("pending")] });
    await posted.edit({ components: [enterRow(posted.id)] });
    gw(ctx.guild.id)[posted.id] = g;
    save();
    await ctx.ok(`Giveaway started in ${ch}. ID: \`${posted.id}\``);
  },
  "giveaway end": async (ctx) => { const w = await endGiveaway(ctx.guild, ctx.args[0]); await ctx.ok(`Ended the giveaway with **${w.length}** winner${w.length === 1 ? "" : "s"}.`); },
  "giveaway reroll": async (ctx) => {
    if (!needGiveaway(ctx).ended) throw new CommandError("End the giveaway first.");
    const w = await endGiveaway(ctx.guild, ctx.args[0], true, parseInteger(ctx.args[1]) ?? undefined);
    await ctx.ok(`Rerolled. New winners: ${w.map((x) => `<@${x}>`).join(", ") || "none"}.`);
  },
  "giveaway delete": async (ctx) => {
    const g = needGiveaway(ctx);
    const channel = sendable(ctx.guild.channels.cache.get(g.channelId));
    await channel?.messages.delete(ctx.args[0]).catch(() => undefined);
    delete gw(ctx.guild.id)[ctx.args[0]];
    save();
    await ctx.ok("Deleted the giveaway.");
  },
  "giveaway list": async (ctx) => {
    const rows = Object.entries(gw(ctx.guild.id)).filter(([, g]) => !g.ended).map(([id, g]) => `\`${id}\` **${g.prize}** ends ${stamp(g.endsAt)}`);
    await ctx.reply(embed(rows.join("\n") || "No active giveaways.", "Giveaways"));
  },
  "giveaway edit duration": async (ctx) => { const g = needGiveaway(ctx); const ms = parseDuration(ctx.args[1]); if (!ms) throw new UsageError(); g.endsAt = Date.now() + ms; save(); await refresh(ctx, ctx.args[0]); await ctx.ok(`The giveaway now ends in ${formatDuration(ms)}.`); },
  "giveaway edit winners": async (ctx) => { const g = needGiveaway(ctx); const n = parseInteger(ctx.args[1]); if (!n || n < 1 || n > 20) throw new UsageError(); g.winners = n; save(); await refresh(ctx, ctx.args[0]); await ctx.ok(`The giveaway now has **${n}** winners.`); },
  "giveaway edit price": async (ctx) => { const g = needGiveaway(ctx); g.prize = ctx.args.slice(1).join(" "); save(); await refresh(ctx, ctx.args[0]); await ctx.ok("Updated the prize."); },
  "giveaway edit host": async (ctx) => { const g = needGiveaway(ctx); const m = await parseMember(ctx, ctx.args[1]); if (!m) throw new CommandError("I could not find that member."); g.hostId = m.id; save(); await refresh(ctx, ctx.args[0]); await ctx.ok(`${m} is now the host.`); },
};

/* ======================= STARBOARD ======================= */
const sb = (g: string): Record<string, Bag> => (guildData(g).starboards ??= {});
const emojiKey = (e: string) => e.match(/^<a?:\w+:(\d+)>$/)?.[1] ?? e;

const STARBOARD_HANDLERS: Record<string, Handler> = {
  "starboard create": async (ctx) => {
    const [name] = ctx.args;
    const ch = await textChannel(ctx, ctx.args[1]);
    if (sb(ctx.guild.id)[name]) throw new CommandError("A starboard with that name already exists.");
    sb(ctx.guild.id)[name] = { channelId: ch.id, emoji: emojiKey(ctx.args[2]), display: ctx.args[2], threshold: parseInteger(ctx.args[3]) ?? 3, posts: {}, exceptions: [] };
    save();
    await ctx.ok(`Created the starboard **${name}** in ${ch}.`);
  },
  "starboard delete": async (ctx) => {
    if (!sb(ctx.guild.id)[ctx.args[0]]) throw new CommandError("I could not find that starboard.");
    delete sb(ctx.guild.id)[ctx.args[0]];
    save();
    await ctx.ok("Deleted the starboard.");
  },
  "starboard list": async (ctx) => {
    const rows = Object.entries(sb(ctx.guild.id)).map(([n, s]) => `**${n}** ${s.display} x${s.threshold} -> <#${s.channelId}>`);
    await ctx.reply(embed(rows.join("\n") || "No starboards.", "Starboards"));
  },
  "starboard emoji": async (ctx) => {
    const board = sb(ctx.guild.id)[ctx.args[1]];
    if (!board || !ctx.args[2]) throw new CommandError("Use `starboard emoji set (name) (emoji)`.");
    board.emoji = emojiKey(ctx.args[2]);
    board.display = ctx.args[2];
    save();
    await ctx.ok(`The starboard now uses ${ctx.args[2]}.`);
  },
  "starboard exception add": async (ctx) => {
    const board = sb(ctx.guild.id)[ctx.args[0]];
    const target = parseChannel(ctx, ctx.args[1])?.id ?? (await parseMember(ctx, ctx.args[1]))?.id ?? parseRole(ctx, ctx.args[1])?.id;
    if (!board || !target) throw new CommandError("Use `starboard exception add (name) (channel/member/role)`.");
    if (!board.exceptions.includes(target)) board.exceptions.push(target);
    save();
    await ctx.ok("Added the exception.");
  },
  "starboard exception remove": async (ctx) => {
    const board = sb(ctx.guild.id)[ctx.args[0]];
    const target = parseChannel(ctx, ctx.args[1])?.id ?? (await parseMember(ctx, ctx.args[1]))?.id ?? parseRole(ctx, ctx.args[1])?.id;
    if (!board) throw new CommandError("I could not find that starboard.");
    board.exceptions = board.exceptions.filter((x: string) => x !== target);
    save();
    await ctx.ok("Removed the exception.");
  },
};

async function onStarReaction(reaction: any, user: User): Promise<void> {
  if (user.bot) return;
  const r = reaction.partial ? await reaction.fetch() : reaction;
  const message: Message = r.message.partial ? await r.message.fetch() : r.message;
  if (!message.inGuild()) return;
  const boards = sb(message.guild.id);
  for (const board of Object.values(boards)) {
    if (board.emoji !== (r.emoji.id ?? r.emoji.name) || message.channelId === board.channelId) continue;
    if (board.exceptions.includes(message.channelId) || board.exceptions.includes(message.author.id)) continue;
    const count: number = r.count ?? 0;
    const target = sendable(message.guild.channels.cache.get(board.channelId));
    if (!target) continue;
    const text = `${board.display} **${count}** | ${message}`;
    const existing = board.posts[message.id];
    if (existing) {
      const post = await target.messages.fetch(existing).catch(() => null);
      await post?.edit({ content: text }).catch(() => undefined);
    } else if (count >= board.threshold) {
      const card = new EmbedBuilder().setColor(WHITE).setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() }).setDescription(message.content || "\u200b").addFields({ name: "Source", value: `[Jump to message](${message.url})` }).setTimestamp(message.createdAt);
      const image = message.attachments.find((a) => a.contentType?.startsWith("image/"));
      if (image) card.setImage(image.url);
      const post = await target.send({ content: text, embeds: [card] });
      board.posts[message.id] = post.id;
      save();
    }
  }
}

/* ======================= BIRTHDAYS ======================= */
const bd = (g: string): Bag => (guildData(g).birthday ??= { enabled: false, roles: [], hour: 0, active: {}, base: "Happy birthday {user.mention}!", age: "Happy {age}th birthday {user.mention}!" });
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseDate(input: string): { month: number; day: number; year?: number } | null {
  let m = input.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?$/);
  let month: number, day: number, year: number | undefined;
  if (m) { month = Number(m[1]); day = Number(m[2]); year = m[3] ? Number(m[3]) : undefined; }
  else {
    m = input.toLowerCase().match(/^([a-z]{3})[a-z]*\s+(\d{1,2})(?:[ ,]+(\d{4}))?$/);
    if (!m || !MONTHS.includes(m[1])) return null;
    month = MONTHS.indexOf(m[1]) + 1; day = Number(m[2]); year = m[3] ? Number(m[3]) : undefined;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day, year };
}

const BIRTHDAY_HANDLERS: Record<string, Handler> = {
  "birthday set": async (ctx) => {
    const date = parseDate(ctx.raw);
    if (!date) throw new CommandError("Use `MM/DD`, `MM/DD/YYYY` or `March 14`.");
    userData(ctx.member.id).birthday = date;
    save();
    await ctx.ok(`Your birthday is saved as **${MONTHS[date.month - 1]} ${date.day}**.`);
  },
  birthday: async (ctx) => {
    const member = ctx.args[0] ? await parseMember(ctx, ctx.args[0]) : ctx.member;
    const b = member && userData(member.id).birthday;
    if (!member || !b) throw new CommandError(`${member ? "They have" : "That member does not have"} no birthday set.`);
    await ctx.ok(`${member}'s birthday is **${MONTHS[b.month - 1]} ${b.day}**.`);
  },
  "birthday channel": async (ctx) => { bd(ctx.guild.id).channel = (await textChannel(ctx)).id; save(); await ctx.ok("Birthday announcements will be sent there."); },
  "birthday enable": async (ctx) => { bd(ctx.guild.id).enabled = true; save(); await ctx.ok("Birthday announcements are enabled."); },
  "birthday disable": async (ctx) => { bd(ctx.guild.id).enabled = false; save(); await ctx.ok("Birthday announcements are disabled."); },
  "birthday time": async (ctx) => {
    const hour = parseInteger(ctx.args[0]?.replace(/h$/i, ""));
    if (hour === null || hour < 0 || hour > 23) throw new CommandError("Enter an hour from 0 to 23 (UTC).");
    bd(ctx.guild.id).hour = hour;
    save();
    await ctx.ok(`Birthdays will be announced at **${hour}:00 UTC**.`);
  },
  "birthday message base": async (ctx) => { bd(ctx.guild.id).base = ctx.raw; save(); await ctx.ok("Updated the birthday message."); },
  "birthday message age": async (ctx) => { bd(ctx.guild.id).age = ctx.raw; save(); await ctx.ok("Updated the birthday message for members with an age. Use {age}."); },
  "birthday role add": async (ctx) => { const r = parseRole(ctx, ctx.raw); if (!r) throw new CommandError("I could not find that role."); const c = bd(ctx.guild.id); if (!c.roles.includes(r.id)) c.roles.push(r.id); save(); await ctx.ok(`${r} will be given on birthdays.`); },
  "birthday role remove": async (ctx) => { const r = parseRole(ctx, ctx.raw); const c = bd(ctx.guild.id); c.roles = c.roles.filter((x: string) => x !== r?.id); save(); await ctx.ok("Removed the birthday role."); },
  "birthday settings": async (ctx) => {
    const c = bd(ctx.guild.id);
    await ctx.reply(embed([`**Enabled:** ${c.enabled ? "Yes" : "No"}`, `**Channel:** ${c.channel ? `<#${c.channel}>` : "Not set"}`, `**Time:** ${c.hour}:00 UTC`, `**Roles:** ${c.roles.map((r: string) => `<@&${r}>`).join(", ") || "None"}`, `**Message:** ${c.base}`].join("\n"), "Birthday settings"));
  },
};

async function checkBirthdays(client: Client): Promise<void> {
  const now = new Date();
  const today = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
  for (const guild of client.guilds.cache.values()) {
    const c = bd(guild.id);
    if (!c.enabled) continue;
    for (const [id, day] of Object.entries<string>(c.active)) {
      if (day === today) continue;
      const member = await guild.members.fetch(id).catch(() => null);
      for (const r of c.roles) await member?.roles.remove(r).catch(() => undefined);
      delete c.active[id];
      save();
    }
    if (now.getUTCHours() < c.hour) continue;
    for (const [userId, bag] of Object.entries(allUsers())) {
      const b = bag.birthday;
      if (!b || b.month !== now.getUTCMonth() + 1 || b.day !== now.getUTCDate() || c.active[userId]) continue;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      c.active[userId] = today;
      save();
      for (const r of c.roles) await member.roles.add(r, "Birthday").catch(() => undefined);
      const ch = sendable(guild.channels.cache.get(c.channel ?? ""));
      const text = (b.year ? c.age : c.base).replaceAll("{age}", String(now.getUTCFullYear() - (b.year ?? now.getUTCFullYear())));
      await ch?.send({ content: renderTemplate(text, member.user, guild), allowedMentions: { users: [userId] } }).catch(() => undefined);
    }
  }
}

export const ENGAGEMENT_HANDLERS: Record<string, Handler> = { ...LEVEL_HANDLERS, ...GIVEAWAY_HANDLERS, ...STARBOARD_HANDLERS, ...BIRTHDAY_HANDLERS };

export function startEngagement(client: Client): void {
  client.on("messageCreate", (m) => guard("Leveling", () => onLevelMessage(m)));
  client.on("messageReactionAdd", (r, u) => guard("Starboard", () => onStarReaction(r, u as User)));
  client.on("messageReactionRemove", (r, u) => guard("Starboard", () => onStarReaction(r, u as User)));

  client.on(Events.InteractionCreate, (i) => guard("Giveaway entry", async () => {
    if (!i.isButton() || !i.customId.startsWith("gw:enter:") || !i.guildId) return;
    const id = i.customId.split(":")[2];
    const g = gw(i.guildId)[id];
    if (!g || g.ended) return void (await i.reply({ content: "This giveaway has ended.", flags: MessageFlags.Ephemeral }));
    const joined = g.entrants.includes(i.user.id);
    g.entrants = joined ? g.entrants.filter((x: string) => x !== i.user.id) : [...g.entrants, i.user.id];
    save();
    await i.update({ embeds: [giveawayCard(g)] });
    await i.followUp({ content: joined ? "You left the giveaway." : "You entered the giveaway.", flags: MessageFlags.Ephemeral });
  }));

  setInterval(() => {
    guard("Giveaway timer", async () => {
      for (const guild of client.guilds.cache.values()) {
        for (const [id, g] of Object.entries(gw(guild.id))) if (!g.ended && g.endsAt <= Date.now()) await endGiveaway(guild, id).catch(() => undefined);
      }
    });
    guard("Birthdays", () => checkBirthdays(client));
  }, 30_000).unref();
}
