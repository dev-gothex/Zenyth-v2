import { PermissionFlagsBits, type GuildMember, type TextChannel } from "discord.js";
import { guildData, save } from "../../store";
import { formatDuration, parseChannel, parseDuration, parseInteger, parseMember, parseUser } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";

const MAX_TIMEOUT = 28 * 86_400_000;
const reason = (ctx: Ctx, from: number) => ctx.args.slice(from).join(" ") || "No reason provided";
const audit = (ctx: Ctx, text: string) => `${text} (by ${ctx.member.user.tag})`;

function assertCanAct(ctx: Ctx, target: GuildMember): void {
  if (target.id === ctx.member.id) throw new CommandError("You cannot do that to yourself.");
  if (target.id === ctx.guild.ownerId) throw new CommandError("You cannot do that to the server owner.");
  if (
    ctx.guild.ownerId !== ctx.member.id &&
    target.roles.highest.position >= ctx.member.roles.highest.position
  ) {
    throw new CommandError("That member's highest role is equal to or above yours.");
  }
}

async function needMember(ctx: Ctx): Promise<GuildMember> {
  const target = await parseMember(ctx, ctx.args[0]);
  if (!target) throw new CommandError("I could not find that member.");
  assertCanAct(ctx, target);
  return target;
}

function warnings(ctx: Ctx): { id: number; userId: string; reason: string; at: number; by: string }[] {
  const bag = guildData(ctx.guild.id);
  return (bag.warnings ??= []);
}

function textChannel(ctx: Ctx, token?: string): TextChannel {
  const ch = token ? parseChannel(ctx, token) : ctx.message.channel;
  if (!ch || !("setRateLimitPerUser" in ch)) throw new CommandError("I could not find that text channel.");
  return ch as TextChannel;
}

async function lockdown(ctx: Ctx, lock: boolean): Promise<void> {
  const ch = textChannel(ctx, ctx.args[0]);
  await ch.permissionOverwrites.edit(ctx.guild.roles.everyone, {
    SendMessages: lock ? false : null,
  });
  await ctx.ok(lock ? `Locked ${ch}.` : `Unlocked ${ch}.`);
}

async function purge(ctx: Ctx, filter: (m: import("discord.js").Message) => boolean, limit: number): Promise<void> {
  const ch = ctx.message.channel as TextChannel;
  const fetched = await ch.messages.fetch({ limit: 100, before: ctx.message.id });
  const picked = [...fetched.values()].filter(filter).slice(0, limit);
  picked.push(ctx.message);
  const deleted = await ch.bulkDelete(picked, true).catch(() => null);
  const count = Math.max(0, (deleted?.size ?? 1) - 1);
  const note = await ch.send({ embeds: [embed(`Deleted **${count}** message${count === 1 ? "" : "s"}.`)] });
  setTimeout(() => void note.delete().catch(() => undefined), 4000);
}

const amountFrom = (token?: string): number => {
  const n = parseInteger(token);
  return n && n > 0 ? Math.min(n, 100) : 50;
};

export const MODERATION_HANDLERS: Record<string, Handler> = {
  ban: async (ctx) => {
    const target = await needMember(ctx);
    if (!target.bannable) throw new CommandError("I cannot ban that member.");
    await target.ban({ reason: audit(ctx, reason(ctx, 1)) });
    await ctx.ok(`Banned **${target.user.tag}**.`);
  },
  softban: async (ctx) => {
    const target = await needMember(ctx);
    if (!target.bannable) throw new CommandError("I cannot ban that member.");
    await target.ban({ reason: audit(ctx, reason(ctx, 1)), deleteMessageSeconds: 7 * 86_400 });
    await ctx.guild.members.unban(target.id, "Softban");
    await ctx.ok(`Softbanned **${target.user.tag}**.`);
  },
  kick: async (ctx) => {
    const target = await needMember(ctx);
    if (!target.kickable) throw new CommandError("I cannot kick that member.");
    await target.kick(audit(ctx, reason(ctx, 1)));
    await ctx.ok(`Kicked **${target.user.tag}**.`);
  },
  unban: async (ctx) => {
    const user = await parseUser(ctx, ctx.args[0]);
    if (!user) throw new CommandError("I could not find that user.");
    await ctx.guild.members.unban(user.id, audit(ctx, reason(ctx, 1))).catch(() => {
      throw new CommandError(`**${user.tag}** is not banned.`);
    });
    await ctx.ok(`Unbanned **${user.tag}**.`);
  },
  "unban all": async (ctx) => {
    const bans = await ctx.guild.bans.fetch();
    await Promise.allSettled(bans.map((b) => ctx.guild.members.unban(b.user.id, audit(ctx, "Unban all"))));
    await ctx.ok(`Unbanned **${bans.size}** user${bans.size === 1 ? "" : "s"}.`);
  },
  timeout: async (ctx) => {
    const target = await needMember(ctx);
    const parsed = parseDuration(ctx.args[1]);
    const ms = Math.min(parsed ?? 3_600_000, MAX_TIMEOUT);
    if (!target.moderatable) throw new CommandError("I cannot time out that member.");
    await target.timeout(ms, audit(ctx, reason(ctx, parsed ? 2 : 1)));
    await ctx.ok(`Timed out **${target.user.tag}** for ${formatDuration(ms)}.`);
  },
  "timeout list": async (ctx) => {
    await ctx.guild.members.fetch();
    const lines = ctx.guild.members.cache
      .filter((m) => m.isCommunicationDisabled())
      .map((m) => `${m} until <t:${Math.floor((m.communicationDisabledUntilTimestamp ?? 0) / 1000)}:R>`);
    await ctx.reply(embed(lines.join("\n") || "Nobody is timed out.", "Timed out members"));
  },
  untimeout: async (ctx) => {
    const target = await needMember(ctx);
    await target.timeout(null, audit(ctx, reason(ctx, 1)));
    await ctx.ok(`Removed the timeout from **${target.user.tag}**.`);
  },
  "untimeout all": async (ctx) => {
    await ctx.guild.members.fetch();
    const timed = ctx.guild.members.cache.filter((m) => m.isCommunicationDisabled());
    await Promise.allSettled(timed.map((m) => m.timeout(null, audit(ctx, "Untimeout all"))));
    await ctx.ok(`Lifted **${timed.size}** timeout${timed.size === 1 ? "" : "s"}.`);
  },
  warn: async (ctx) => {
    const target = await needMember(ctx);
    const all = warnings(ctx);
    const id = (all.at(-1)?.id ?? 0) + 1;
    all.push({ id, userId: target.id, reason: reason(ctx, 1), at: Date.now(), by: ctx.member.id });
    save();
    await ctx.ok(`Warned **${target.user.tag}**. Case \`${id}\`.`);
  },
  "warn list": async (ctx) => {
    const target = await parseMember(ctx, ctx.args[0]);
    if (!target) throw new CommandError("I could not find that member.");
    const mine = warnings(ctx).filter((w) => w.userId === target.id);
    const lines = mine.map((w) => `\`${w.id}\` <t:${Math.floor(w.at / 1000)}:d> ${w.reason}`);
    await ctx.reply(embed(lines.join("\n") || "No warnings.", `Warnings for ${target.user.tag}`));
  },
  "warn clear": async (ctx) => {
    const target = await parseMember(ctx, ctx.args[0]);
    if (!target) throw new CommandError("I could not find that member.");
    const bag = guildData(ctx.guild.id);
    bag.warnings = warnings(ctx).filter((w) => w.userId !== target.id);
    save();
    await ctx.ok(`Cleared all warnings for **${target.user.tag}**.`);
  },
  "warn remove": async (ctx) => {
    const id = parseInteger(ctx.args[0]);
    const all = warnings(ctx);
    if (id === null || !all.some((w) => w.id === id)) throw new CommandError("I could not find that case.");
    guildData(ctx.guild.id).warnings = all.filter((w) => w.id !== id);
    save();
    await ctx.ok(`Removed warning case \`${id}\`.`);
  },
  purge: async (ctx) => {
    const user = ctx.args[0] ? await parseUser(ctx, ctx.args[0]) : null;
    const amount = amountFrom(user ? ctx.args[1] : ctx.args[0]);
    await purge(ctx, (m) => (user ? m.author.id === user.id : true), amount);
  },
  "purge bots": (ctx) => purge(ctx, (m) => m.author.bot, amountFrom(ctx.args[0])),
  "purge embeds": (ctx) => purge(ctx, (m) => m.embeds.length > 0, amountFrom(ctx.args[0])),
  "purge contains": (ctx) => {
    const needle = ctx.args[0]?.toLowerCase();
    if (!needle) throw new UsageError();
    return purge(ctx, (m) => m.content.toLowerCase().includes(needle), amountFrom(ctx.args[1]));
  },
  slowmode: async (ctx) => {
    const ch = textChannel(ctx, ctx.args[0]);
    const seconds = parseDuration(ctx.args[1]) !== null ? Math.floor(parseDuration(ctx.args[1])! / 1000) : parseInteger(ctx.args[1]);
    if (seconds === null || seconds < 0 || seconds > 21_600) {
      throw new CommandError("The delay must be between 0 seconds and 6 hours.");
    }
    await ch.setRateLimitPerUser(seconds);
    await ctx.ok(`Set slowmode in ${ch} to **${seconds}s**.`);
  },
  "slowmode disable": async (ctx) => {
    const ch = textChannel(ctx, ctx.args[0]);
    await ch.setRateLimitPerUser(0);
    await ctx.ok(`Disabled slowmode in ${ch}.`);
  },
  nickname: async (ctx) => {
    const target = await needMember(ctx);
    const nick = ctx.args.slice(1).join(" ").slice(0, 32) || null;
    await target.setNickname(nick, audit(ctx, "Nickname change"));
    await ctx.ok(nick ? `Changed **${target.user.tag}**'s nickname to **${nick}**.` : "Reset the nickname.");
  },
  "nickname remove": async (ctx) => {
    const target = await needMember(ctx);
    await target.setNickname(null, audit(ctx, "Nickname reset"));
    await ctx.ok(`Reset **${target.user.tag}**'s nickname.`);
  },
  lockdown: (ctx) => lockdown(ctx, true),
  unlockdown: (ctx) => lockdown(ctx, false),
  topic: async (ctx) => {
    const ch = textChannel(ctx, ctx.args[0]);
    await ch.setTopic(ctx.args.slice(1).join(" ").slice(0, 1024));
    await ctx.ok(`Updated the topic of ${ch}.`);
  },
  "topic remove": async (ctx) => {
    const ch = textChannel(ctx, ctx.args[0]);
    await ch.setTopic(null);
    await ctx.ok(`Removed the topic of ${ch}.`);
  },
  nuke: async (ctx) => {
    const ch = textChannel(ctx);
    if (!ctx.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new CommandError("I need the Manage Channels permission.");
    }
    const clone = await ch.clone({ reason: audit(ctx, "Nuke") });
    await clone.setPosition(ch.position);
    await ch.delete(audit(ctx, "Nuke"));
    await clone.send({ embeds: [embed("This channel was nuked.")] });
  },
  pin: async (ctx) => {
    const target = await ctx.message.channel.messages.fetch(ctx.args[0]).catch(() => null);
    if (!target) throw new CommandError("I could not find that message in this channel.");
    await target.pin();
    await ctx.ok("Pinned the message.");
  },
  unpin: async (ctx) => {
    const target = await ctx.message.channel.messages.fetch(ctx.args[0]).catch(() => null);
    if (!target) throw new CommandError("I could not find that message in this channel.");
    await target.unpin();
    await ctx.ok("Unpinned the message.");
  },
};
