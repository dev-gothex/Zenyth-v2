import { EmbedBuilder, type Client } from "discord.js";
import { logger } from "../../../lib/logger";
import { allUsers, guildData, save, userData } from "../../store";
import { parseChannel, parseUser } from "../args";
import { CommandError, type Ctx, type Handler } from "../types";
import { WHITE, embed } from "../ui";

interface History {
  names: { name: string; at: number }[];
  avatars: { url: string; at: number }[];
  avatarOptOut?: boolean;
}
const history = (id: string): History => ((userData(id).history ??= { names: [], avatars: [] }) as History);
type Kind = "names" | "pfps" | "banners" | "vanities";
const trackCfg = (guildId: string) => ((guildData(guildId).trackChannels ??= {}) as Partial<Record<Kind, string>>);
const when = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

function setChannel(kind: Kind): Handler {
  return async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    if (!ch?.isTextBased()) throw new CommandError("I could not find that text channel.");
    trackCfg(ctx.guild.id)[kind] = ch.id;
    save();
    await ctx.ok(`Change alerts for ${kind} will be posted in ${ch}.`);
  };
}
function clearChannel(kind: Kind): Handler {
  return async (ctx) => {
    delete trackCfg(ctx.guild.id)[kind];
    save();
    await ctx.ok(`Disabled ${kind} alerts.`);
  };
}

async function viewAvatars(ctx: Ctx): Promise<void> {
  const user = ctx.args[0] ? await parseUser(ctx, ctx.args[0]) : ctx.member.user;
  if (!user) throw new CommandError("I could not find that user.");
  const h = history(user.id).avatars;
  const lines = h.slice(-10).reverse().map((a) => `${when(a.at)} [avatar](${a.url})`);
  const card = new EmbedBuilder().setColor(WHITE).setTitle(`${user.username}'s avatar history`).setDescription(lines.join("\n") || "Nothing recorded yet.");
  if (h.length) card.setThumbnail(h[h.length - 1].url);
  await ctx.reply(card);
}

export const TRACK_HANDLERS: Record<string, Handler> = {
  "track names": setChannel("names"),
  "track pfps": setChannel("pfps"),
  "track banners": setChannel("banners"),
  "track vanities": setChannel("vanities"),
  "track names disable": clearChannel("names"),
  "track pfps disable": clearChannel("pfps"),
  "track banners disable": clearChannel("banners"),
  "track vanities disable": clearChannel("vanities"),
  "avatarhistory view": viewAvatars,
  avh: viewAvatars,
  "avatarhistory enable": async (ctx) => {
    history(ctx.member.id).avatarOptOut = false;
    save();
    await ctx.ok("Avatar history tracking is on.");
  },
  "avatarhistory disable": async (ctx) => {
    history(ctx.member.id).avatarOptOut = true;
    save();
    await ctx.ok("Avatar history tracking is off.");
  },
  "avatarhistory clear": async (ctx) => {
    history(ctx.member.id).avatars = [];
    save();
    await ctx.ok("Cleared your avatar history.");
  },
  namehistory: async (ctx) => {
    const user = ctx.args[0] ? await parseUser(ctx, ctx.args[0]) : ctx.member.user;
    if (!user) throw new CommandError("I could not find that user.");
    const lines = history(user.id).names.slice(-15).reverse().map((n) => `\`${n.name}\` ${when(n.at)}`);
    await ctx.reply(embed(lines.join("\n") || "Nothing recorded yet.", `${user.username}'s name history`));
  },
  "namehistory clear": async (ctx) => {
    history(ctx.member.id).names = [];
    save();
    await ctx.ok("Cleared your name history.");
  },
  checkvanity: async (ctx) => {
    const code = ctx.args[0].replace(/^.*\//, "").toLowerCase();
    const res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res) throw new CommandError("I could not reach Discord to check that.");
    await ctx.ok(res.status === 404 ? `\`${code}\` looks available.` : `\`${code}\` is taken.`);
  },
  stalk: async (ctx) => {
    const user = await parseUser(ctx, ctx.args[0]);
    if (!user || user.id === ctx.member.id) throw new CommandError("Pick someone else.");
    const bag = userData(ctx.member.id);
    const list = (bag.stalking ??= []) as string[];
    if (!list.includes(user.id)) list.push(user.id);
    save();
    await ctx.ok(`You will get a DM when ${user} is active.`);
  },
  "stalk list": async (ctx) => {
    const list = (userData(ctx.member.id).stalking ?? []) as string[];
    await ctx.reply(embed(list.map((id) => `<@${id}>`).join("\n") || "You are not stalking anyone.", "Stalking"));
  },
  "stalk stop": async (ctx) => {
    const user = await parseUser(ctx, ctx.args[0]);
    if (!user) throw new CommandError("I could not find that user.");
    const bag = userData(ctx.member.id);
    bag.stalking = ((bag.stalking ?? []) as string[]).filter((id) => id !== user.id);
    save();
    await ctx.ok(`You stopped stalking ${user}.`);
  },
};

export function startTracking(client: Client): void {
  client.on("userUpdate", (before, after) => {
    void (async () => {
      const h = history(after.id);
      const alerts: [Kind, string][] = [];
      if (before.username !== after.username) {
        h.names.push({ name: after.username, at: Date.now() });
        alerts.push(["names", `**${before.username}** is now **${after.username}**`]);
      }
      if (before.avatar !== after.avatar) {
        if (!h.avatarOptOut) h.avatars.push({ url: after.displayAvatarURL({ size: 512 }), at: Date.now() });
        alerts.push(["pfps", `${after} changed their avatar.`]);
      }
      if (before.banner !== undefined && after.banner !== undefined && before.banner !== after.banner) {
        alerts.push(["banners", `${after} changed their banner.`]);
      }
      save();
      for (const guild of client.guilds.cache.values()) {
        if (!guild.members.cache.has(after.id)) continue;
        for (const [kind, text] of alerts) {
          const id = trackCfg(guild.id)[kind];
          const channel = id ? guild.channels.cache.get(id) : undefined;
          if (channel?.isTextBased()) await channel.send({ embeds: [embed(text)], allowedMentions: { parse: [] } }).catch(() => undefined);
        }
      }
    })().catch((err: unknown) => logger.error({ err }, "Tracking failed"));
  });

  const notify = (userId: string, text: string) => {
    for (const [watcherId, bag] of Object.entries(allUsers())) {
      if (((bag.stalking ?? []) as string[]).includes(userId)) {
        void client.users.send(watcherId, text).catch(() => undefined);
      }
    }
  };
  client.on("messageCreate", (m) => {
    if (!m.author.bot && m.inGuild()) notify(m.author.id, `${m.author.tag} sent a message in ${m.guild.name} #${m.channel.name}.`);
  });
  client.on("voiceStateUpdate", (before, after) => {
    if (!before.channelId && after.channel) notify(after.id, `${after.member?.user.tag} joined ${after.channel.name} in ${after.guild.name}.`);
  });
}
