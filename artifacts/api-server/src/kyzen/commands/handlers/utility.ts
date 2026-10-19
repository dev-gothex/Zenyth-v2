import { createHash } from "node:crypto";
import { EmbedBuilder, type GuildMember, type User } from "discord.js";
import { formatDuration, parseChannel, parseMember, parseRole, parseUser } from "../args";
import { CommandError, type Ctx, type Handler } from "../types";
import { WHITE, embed } from "../ui";

const stamp = (ms: number) => `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;
const DISCORD_EPOCH = 1_420_070_400_000n;
const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

async function userArg(ctx: Ctx): Promise<User> {
  if (!ctx.args[0]) return ctx.member.user;
  const user = await parseUser(ctx, ctx.args[0]);
  if (!user) throw new CommandError("I could not find that user.");
  return user;
}

function text(line: (a: string, b?: string) => string): Handler {
  return async (ctx) => {
    const target = ctx.args[0] ? await parseUser(ctx, ctx.args[0]) : null;
    await ctx.reply(embed(line(`**${ctx.member.displayName}**`, target ? `**${target.displayName}**` : undefined)));
  };
}

async function extreme(ctx: Ctx, pick: (a: GuildMember, b: GuildMember) => boolean, label: string, by: "join" | "created"): Promise<void> {
  const members = await ctx.guild.members.fetch();
  const found = members.filter((m) => !m.user.bot).reduce<GuildMember | undefined>((best, m) => (!best || pick(m, best) ? m : best), undefined);
  if (!found) throw new CommandError("No members found.");
  const when = by === "join" ? (found.joinedTimestamp ?? 0) : found.user.createdTimestamp;
  await ctx.reply(embed(`${found} - ${stamp(when)}`, label));
}

const hashHandler = (algorithm: string): Handler => async (ctx) => {
  await ctx.reply(embed(`\`${createHash(algorithm).update(ctx.raw).digest("hex")}\``, algorithm.toUpperCase()));
};

export const UTILITY_HANDLERS: Record<string, Handler> = {
  ping: async (ctx) => {
    const trip = Date.now() - ctx.message.createdTimestamp;
    await ctx.reply(embed(`**Gateway:** ${Math.round(ctx.client.ws.ping)}ms\n**Round trip:** ${trip}ms`, "Pong"));
  },
  uptime: async (ctx) => {
    await ctx.reply(embed(`Online for **${formatDuration(process.uptime() * 1000)}**.`));
  },
  avatar: async (ctx) => {
    const user = await userArg(ctx);
    await ctx.reply(new EmbedBuilder().setColor(WHITE).setTitle(`${user.username}'s avatar`).setImage(user.displayAvatarURL({ size: 1024 })));
  },
  banner: async (ctx) => {
    const user = await (await userArg(ctx)).fetch(true);
    const url = user.bannerURL({ size: 1024 });
    if (!url) throw new CommandError(`${user.username} has no banner.`);
    await ctx.reply(new EmbedBuilder().setColor(WHITE).setTitle(`${user.username}'s banner`).setImage(url));
  },
  memberbanner: async (ctx) => {
    const member = ctx.args[0] ? await parseMember(ctx, ctx.args[0]) : ctx.member;
    const url = member?.bannerURL({ size: 1024 });
    if (!member || !url) throw new CommandError("That member has no server banner.");
    await ctx.reply(new EmbedBuilder().setColor(WHITE).setImage(url));
  },
  whois: async (ctx) => {
    const member = ctx.args[0] ? await parseMember(ctx, ctx.args[0]) : ctx.member;
    if (!member) throw new CommandError("I could not find that member.");
    const roles = member.roles.cache.filter((r) => r.id !== ctx.guild.id).sort((a, b) => b.position - a.position);
    await ctx.reply(
      new EmbedBuilder()
        .setColor(WHITE)
        .setTitle(member.user.tag)
        .setThumbnail(member.displayAvatarURL({ size: 256 }))
        .setDescription(
          [
            `**ID:** ${member.id}`,
            `**Created:** ${stamp(member.user.createdTimestamp)}`,
            `**Joined:** ${member.joinedTimestamp ? stamp(member.joinedTimestamp) : "Unknown"}`,
            `**Roles (${roles.size}):** ${roles.first(10).join(" ") || "None"}`,
          ].join("\n"),
        ),
    );
  },
  color: async (ctx) => {
    const token = ctx.args[0];
    const hex = token && /^#?[0-9a-f]{6}$/i.test(token) ? token.replace("#", "") : ctx.member.displayHexColor.replace("#", "");
    await ctx.reply(new EmbedBuilder().setColor(parseInt(hex, 16)).setDescription(`**#${hex.toUpperCase()}**\nDecimal: ${parseInt(hex, 16)}`));
  },
  charinfo: async (ctx) => {
    const lines = [...ctx.raw].slice(0, 20).map((c) => `\`${c}\` U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
    await ctx.reply(embed(lines.join("\n")));
  },
  timediff: async (ctx) => {
    const [a, b] = ctx.args;
    if (!/^\d{15,22}$/.test(a) || !/^\d{15,22}$/.test(b)) throw new CommandError("Both values must be Discord IDs.");
    const diff = Math.abs(snowflakeTime(a) - snowflakeTime(b));
    await ctx.reply(embed(`The difference is **${formatDuration(diff)}**.`));
  },
  boomer: (ctx) => extreme(ctx, (m, b) => (m.joinedTimestamp ?? Infinity) < (b.joinedTimestamp ?? Infinity), "Longest member", "join"),
  oldest: (ctx) => extreme(ctx, (m, b) => m.user.createdTimestamp < b.user.createdTimestamp, "Oldest account", "created"),
  youngest: (ctx) => extreme(ctx, (m, b) => m.user.createdTimestamp > b.user.createdTimestamp, "Youngest account", "created"),
  serverinfo: async (ctx) => {
    const g = ctx.guild;
    await ctx.reply(
      new EmbedBuilder()
        .setColor(WHITE)
        .setTitle(g.name)
        .setThumbnail(g.iconURL({ size: 256 }))
        .setDescription(
          [
            `**ID:** ${g.id}`,
            `**Owner:** <@${g.ownerId}>`,
            `**Created:** ${stamp(g.createdTimestamp)}`,
            `**Members:** ${g.memberCount}`,
            `**Channels:** ${g.channels.cache.size}`,
            `**Roles:** ${g.roles.cache.size}`,
            `**Boosts:** ${g.premiumSubscriptionCount ?? 0}`,
          ].join("\n"),
        ),
    );
  },
  servericon: async (ctx) => {
    const url = ctx.guild.iconURL({ size: 1024 });
    if (!url) throw new CommandError("This server has no icon.");
    await ctx.reply(new EmbedBuilder().setColor(WHITE).setImage(url));
  },
  serveravatar: async (ctx) => {
    const url = ctx.member.avatarURL({ size: 1024 });
    if (!url) throw new CommandError("You have no server avatar.");
    await ctx.reply(new EmbedBuilder().setColor(WHITE).setImage(url));
  },
  serverbanner: async (ctx) => {
    const url = ctx.guild.bannerURL({ size: 1024 });
    if (!url) throw new CommandError("This server has no banner.");
    await ctx.reply(new EmbedBuilder().setColor(WHITE).setImage(url));
  },
  roleinfo: async (ctx) => {
    const role = parseRole(ctx, ctx.args[0]) ?? ctx.member.roles.highest;
    await ctx.reply(
      new EmbedBuilder()
        .setColor(role.color || WHITE)
        .setTitle(role.name)
        .setDescription(
          [
            `**ID:** ${role.id}`,
            `**Color:** ${role.hexColor}`,
            `**Members:** ${role.members.size}`,
            `**Position:** ${role.position}`,
            `**Mentionable:** ${role.mentionable ? "Yes" : "No"}`,
            `**Created:** ${stamp(role.createdTimestamp)}`,
          ].join("\n"),
        ),
    );
  },
  channelinfo: async (ctx) => {
    const channel = ctx.args[0] ? parseChannel(ctx, ctx.args[0]) : ctx.message.channel;
    if (!channel || !("name" in channel)) throw new CommandError("I could not find that channel.");
    await ctx.reply(embed([`**ID:** ${channel.id}`, `**Type:** ${channel.type}`, `**Created:** ${stamp(snowflakeTime(channel.id))}`].join("\n"), `#${channel.name}`));
  },
  tableflip: text((a) => `${a} flips the table. (╯°□°)╯︵ ┻━┻`),
  nod: text((a, b) => (b ? `${a} nods at ${b}.` : `${a} nods.`)),
  bored: text((a, b) => (b ? `${a} is bored and pokes ${b}.` : `${a} is bored.`)),
  ...Object.fromEntries(["md5", "sha1", "sha224", "sha256", "sha384", "sha512"].map((alg) => [`hash ${alg}`, hashHandler(alg)])),
};
