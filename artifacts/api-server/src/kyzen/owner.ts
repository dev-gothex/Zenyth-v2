import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  Events,
  MessageFlags,
  type Client,
  type Guild,
  type Message,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type TextChannel,
  type User,
} from "discord.js";
import { logger } from "../lib/logger";
import { resolveCommand } from "./commands/dispatcher";
import { allUsers, flushNow, globalData, reloadStore, save, userData } from "./store";
import { formatDuration, parseDuration } from "./commands/args";
import { ENV_OWNERS, HARD_OWNER, staffLists } from "./staff";
import { guildPrefix, matchPrefix } from "./prefix";
import { ZENYTH_PREFIX } from "./modules";

export { staffLists };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bag = Record<string, any>;

const WHITE = 0xffffff;

/** 3 = owner, 2 = developer, 1 = admin/core, 0 = nobody. */
export function accessLevel(userId: string): number {
  if (userId === HARD_OWNER || ENV_OWNERS.includes(userId)) return 3;
  const s = state().staff;
  if (s.devs.includes(userId)) return 2;
  if (s.admins.includes(userId) || s.core.includes(userId)) return 1;
  return 0;
}

export function state(): Bag {
  const s = globalData();
  s.blacklist ??= {};
  s.serverBans ??= {};
  s.globalBans ??= {};
  s.guildNP ??= [];
  s.noprefix ??= {};
  s.premium ??= {};
  s.premiumGuilds ??= {};
  s.staff ??= { admins: [], devs: [], core: [] };
  s.branding ??= {};
  s.shipImages ??= [];
  s.votes ??= {};
  s.trial ??= { durationMs: 86_400_000, claimed: {} };
  return s;
}

export function isPremiumGuild(guildId: string): boolean {
  return Boolean(state().premiumGuilds[guildId]);
}

/* ---------- helpers ---------- */
const embed = (text: string, title?: string) => {
  const e = new EmbedBuilder().setColor(WHITE).setDescription(text.slice(0, 4000));
  if (title) e.setTitle(title);
  return e;
};
const stamp = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;
const isId = (s?: string) => Boolean(s && /^\d{15,22}$/.test(s));
const idOf = (token?: string): string | undefined => token?.match(/^<@!?(\d+)>$/)?.[1] ?? (isId(token) ? token : undefined);

/** undefined = invalid, null = permanent, number = milliseconds. */
function parseDur(token?: string): number | null | undefined {
  if (!token) return undefined;
  if (["perm", "permanent", "lifetime", "forever"].includes(token.toLowerCase())) return null;
  return parseDuration(token) ?? undefined;
}
const until = (ms: number | null) => (ms === null ? null : Date.now() + ms);
/** 7 days, 12 hours, 30 minutes... */
function longDuration(ms: number): string {
  const units: [string, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];
  for (const [name, size] of units) {
    if (ms >= size) {
      const n = Math.round(ms / size);
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return "under a minute";
}

/** Sends a white embed DM from the bot. Returns false when the user has DMs closed. */
export async function dmEmbed(client: Client, userId: string, title: string, text: string): Promise<boolean> {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return false;
  const card = new EmbedBuilder().setColor(WHITE).setTitle(title).setDescription(text).setTimestamp();
  if (client.user) card.setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL() });
  return user.send({ embeds: [card] }).then(() => true).catch(() => false);
}
const accessText = (at: number | null) => (at === null ? "This access does not expire." : `It expires <t:${Math.floor(at / 1000)}:R> (<t:${Math.floor(at / 1000)}:f>).`);

const whenText = (at: number | null) => (at === null ? "permanent" : `expires ${stamp(at)}`);

interface OCtx {
  client: Client;
  message: Message;
  args: string[];
  raw: string;
  prefix: string;
  reply(text: string, title?: string): Promise<unknown>;
  /** DMs the user an embed unless `--nodm` was given. Returns a short note for the reply. */
  dm(userId: string, title: string, text: string): Promise<string>;
}
class OwnerError extends Error {}
const fail = (msg: string): never => { throw new OwnerError(msg); };

async function userArg(c: OCtx, token?: string): Promise<User> {
  const id = idOf(token);
  if (!id) return fail("Mention a user or give a valid user ID.");
  return (await c.client.users.fetch(id).catch(() => null)) ?? fail("I could not find that user.");
}
function guildArg(c: OCtx, token?: string): Guild {
  if (!isId(token)) return fail("Give a valid server ID.");
  return c.client.guilds.cache.get(token!) ?? fail("I am not in that server.");
}

/* ---------- logging webhook ---------- */
const WEBHOOK = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;
export async function ownerLog(text: string): Promise<void> {
  const url = state().logWebhook as string | undefined;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [{ description: text.slice(0, 3900), color: WHITE, timestamp: new Date().toISOString() }], allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
}

/* ---------- the panel ---------- */
const SECTIONS: [string, string[]][] = [
  ["1. Security & Global Restrictions", [".blacklistserver <server_id> [reason]", ".unblacklistserver <server_id>", ".blacklistservers", ".globalban <user_id> [reason]", ".globalunban <user_id>", ".globalbans", ".guildnp <add|remove|status|list>", ".serverban <add|remove|list> <serverId>"]],
  ["2. Server Management", [".serverlist [page]", ".serverleave <serverId>", ".serverjoin"]],
  ["3. Premium Management", [".addprem @user [duration] [slots]", ".removeprem @user", ".pactivate <serverId> @user", ".premiumdeactivate <serverId>"]],
  ["4. No-Prefix Access & Trials", [".noprefix add @user [duration]", ".noprefix remove @user", ".noprefix list", ".garib @user [duration]", ".noprefixtrial setup"]],
  ["5. Branding, Badges & Ship Images", [".branding", ".branding avatar <https-url>", ".branding banner <https-url>", ".branding bio <text>", ".branding server", ".branding reset", ".badge add @user <name> [emoji]", ".badge remove @user <name>", ".badge list [@user]", ".shipimages add", ".shipimages remove", ".shipimages list"]],
  ["6. Staff & Team Management", [".addadmin @user", ".removeadmin @user", ".adddev @user", ".removedev @user", ".stafflist", ".team developers add @user", ".team developers remove @user", ".team core add @user", ".team core remove @user"]],
  ["7. Logs & Audit", [".logchannel set <webhook URL>", ".logchannel disable"]],
  ["8. Database & Cache", [".hydrate", ".flush"]],
  ["9. Diagnostics & Voting", [".recordvote <userId> [weight]", ".dm @user <message>"]],
  ["10. System Operations", [".reboot"]],
];

export function ownerHelpEmbed(client: Client, prefix = ZENYTH_PREFIX): EmbedBuilder {
  const body = SECTIONS.map(([title, lines]) => `**${title}**\n${lines.map((l) => `> ${prefix}${l.slice(1)}`).join("\n")}`).join("\n\n");
  return new EmbedBuilder()
    .setColor(WHITE)
    .setAuthor({ name: client.user?.username ?? "Zenyth", iconURL: client.user?.displayAvatarURL() })
    .setDescription(`# OwnerHelp Commands\n\n${body}`);
}

/* ---------- commands ---------- */
interface Cmd { level: number; sub?: Record<string, number>; run(c: OCtx): Promise<void> }

const onOff = (arr: string[], id: string, add: boolean) => (add ? (arr.includes(id) ? arr : [...arr, id]) : arr.filter((x) => x !== id));

const COMMANDS: Record<string, Cmd> = {
  ownerhelp: { level: 1, run: async (c) => { await c.message.reply({ embeds: [ownerHelpEmbed(c.client, c.prefix)], allowedMentions: { parse: [] } }); } },

  /* 1. security */
  blacklistserver: {
    level: 2,
    run: async (c) => {
      const id = c.args[0];
      if (!isId(id)) fail("Usage: `.blacklistserver <server_id> [reason]`");
      const reason = c.args.slice(1).join(" ") || "No reason provided";
      state().blacklist[id] = { reason, at: Date.now(), by: c.message.author.id };
      save();
      const guild = c.client.guilds.cache.get(id);
      if (guild) await guild.leave().catch(() => undefined);
      await ownerLog(`Blacklisted server \`${id}\`: ${reason}`);
      await c.reply(`Blacklisted \`${id}\`${guild ? ` (${guild.name}) and left the server` : ""}.`);
    },
  },
  unblacklistserver: {
    level: 2,
    run: async (c) => {
      if (!state().blacklist[c.args[0]]) fail("That server is not blacklisted.");
      delete state().blacklist[c.args[0]];
      save();
      await c.reply(`Removed \`${c.args[0]}\` from the blacklist.`);
    },
  },
  blacklistservers: {
    level: 1,
    run: async (c) => {
      const rows = Object.entries<Bag>(state().blacklist).map(([id, b]) => `\`${id}\` - ${b.reason} (${stamp(b.at)})`);
      await c.reply(rows.join("\n") || "No blacklisted servers.", "Blacklisted servers");
    },
  },
  globalban: {
    level: 2,
    run: async (c) => {
      const user = await userArg(c, c.args[0]);
      if (accessLevel(user.id) > 0) fail("You cannot globally ban staff.");
      const reason = c.args.slice(1).join(" ") || "No reason provided";
      const banned: string[] = [];
      for (const guild of c.client.guilds.cache.values()) {
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (member?.bannable && (await guild.bans.create(user.id, { reason: `Global ban: ${reason}` }).then(() => true).catch(() => false))) banned.push(guild.id);
      }
      state().globalBans[user.id] = { reason, at: Date.now(), by: c.message.author.id, tag: user.tag, bannedIn: banned };
      save();
      await ownerLog(`Global ban: ${user.tag} (\`${user.id}\`) - ${reason}`);
      await c.reply(`Globally banned **${user.tag}**. Banned in **${banned.length}** mutual server${banned.length === 1 ? "" : "s"} and blocked from using the bot.`);
    },
  },
  globalunban: {
    level: 2,
    run: async (c) => {
      const id = idOf(c.args[0]);
      const entry = id && state().globalBans[id];
      if (!id || !entry) return fail("That user is not globally banned.");
      let n = 0;
      for (const gid of (entry.bannedIn ?? []) as string[]) {
        const guild = c.client.guilds.cache.get(gid);
        if (guild && (await guild.bans.remove(id, "Global unban").then(() => true).catch(() => false))) n += 1;
      }
      delete state().globalBans[id];
      save();
      await ownerLog(`Global unban: \`${id}\``);
      await c.reply(`Removed the global ban on \`${id}\` and unbanned them in **${n}** server${n === 1 ? "" : "s"}.`);
    },
  },
  globalbans: {
    level: 1,
    run: async (c) => {
      const rows = Object.entries<Bag>(state().globalBans).map(([id, b]) => `\`${id}\` ${b.tag ?? ""} - ${b.reason}`);
      await c.reply(rows.join("\n") || "No global bans.", "Global bans");
    },
  },
  guildnp: {
    level: 2,
    sub: { status: 1, list: 1 },
    run: async (c) => {
      const sub = c.args[0]?.toLowerCase();
      const list = state().guildNP as string[];
      const target = c.args[1] ?? c.message.guildId ?? undefined;
      if (sub === "add" || sub === "remove") {
        if (!isId(target)) fail("Give a server ID, or run this inside the server.");
        state().guildNP = onOff(list, target!, sub === "add");
        save();
        await c.reply(`${sub === "add" ? "Enabled" : "Disabled"} no-prefix commands for \`${target}\`.`);
      } else if (sub === "status") {
        await c.reply(target && list.includes(target) ? `No-prefix is **enabled** for \`${target}\`.` : `No-prefix is **disabled** for \`${target ?? "this chat"}\`.`);
      } else if (sub === "list") {
        await c.reply(list.map((id) => `\`${id}\` ${c.client.guilds.cache.get(id)?.name ?? ""}`).join("\n") || "No servers have no-prefix enabled.", "No-prefix servers");
      } else fail("Usage: `.guildnp <add|remove|status|list> [serverId]`");
    },
  },
  serverban: {
    level: 2,
    sub: { list: 1 },
    run: async (c) => {
      const sub = c.args[0]?.toLowerCase();
      const bans = state().serverBans as Bag;
      if (sub === "list") {
        await c.reply(Object.keys(bans).map((id) => `\`${id}\``).join("\n") || "No banned servers.", "Server bans");
        return;
      }
      const id = c.args[1];
      if ((sub !== "add" && sub !== "remove") || !isId(id)) fail("Usage: `.serverban <add|remove|list> <serverId>`");
      if (sub === "add") {
        bans[id] = { at: Date.now(), by: c.message.author.id };
        await c.client.guilds.cache.get(id)?.leave().catch(() => undefined);
      } else delete bans[id];
      save();
      await c.reply(sub === "add" ? `Banned \`${id}\`. The bot will leave it whenever it joins.` : `Unbanned \`${id}\`.`);
    },
  },

  /* 2. servers */
  serverlist: {
    level: 1,
    run: async (c) => {
      const all = [...c.client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
      const pages = Math.max(1, Math.ceil(all.length / 10));
      const page = Math.min(pages, Math.max(1, Number(c.args[0]) || 1));
      const rows = all.slice((page - 1) * 10, page * 10).map((g, i) => `**${(page - 1) * 10 + i + 1}.** ${g.name} \`${g.id}\` - ${g.memberCount.toLocaleString("en-US")} members`);
      await c.reply(rows.join("\n") || "No servers.", `Servers (page ${page}/${pages}, ${all.length} total)`);
    },
  },
  serverleave: {
    level: 3,
    run: async (c) => {
      const guild = guildArg(c, c.args[0]);
      await guild.leave();
      await ownerLog(`Left server ${guild.name} (\`${guild.id}\`) by owner command.`);
      await c.reply(`Left **${guild.name}**.`);
    },
  },
  serverjoin: {
    level: 2,
    run: async (c) => {
      if (!c.args[0]) {
        const url = `https://discord.com/oauth2/authorize?client_id=${c.client.user?.id}&scope=bot%20applications.commands&permissions=8`;
        await c.reply(`[Add the bot to a server](${url})`);
        return;
      }
      const guild = guildArg(c, c.args[0]);
      const channel = guild.channels.cache.find((ch) => ch.isTextBased() && !ch.isThread() && "createInvite" in ch && guild.members.me?.permissionsIn(ch).has("CreateInstantInvite")) as TextChannel | undefined;
      const invite = await channel?.createInvite({ maxAge: 600, maxUses: 1 }).catch(() => null);
      if (!invite) fail("I could not create an invite there.");
      await c.reply(`Invite for **${guild.name}**: ${invite!.url}`);
    },
  },

  /* 3. premium */
  addprem: {
    level: 2,
    run: async (c) => {
      const user = await userArg(c, c.args[0]);
      let duration: number | null | undefined = null;
      let slots = 1;
      const [a, b] = [c.args[1], c.args[2]];
      if (a && /^\d+$/.test(a) && !b) slots = Number(a);
      else if (a) {
        duration = parseDur(a);
        if (duration === undefined) fail("Use a duration like `30d`, or `perm`.");
        if (b) slots = Number(b);
      }
      if (!Number.isInteger(slots) || slots < 1 || slots > 50) fail("Slots must be a whole number from 1 to 50.");
      const prem = state().premium as Bag;
      prem[user.id] = { expiresAt: until(duration as number | null), slots, by: c.message.author.id };
      save();
      await ownerLog(`Premium added: ${user.tag} (${slots} slots, ${whenText(prem[user.id].expiresAt)})`);
      const note = await c.dm(user.id, "Premium Added", `You now have **Premium** with **${slots}** server slot${slots === 1 ? "" : "s"}. ${accessText(prem[user.id].expiresAt)}\nAsk the staff to activate it in your server.`);
      await c.reply(`Gave ${user} premium with **${slots}** slot${slots === 1 ? "" : "s"} (${whenText(prem[user.id].expiresAt)}).${note}`);
    },
  },
  removeprem: {
    level: 2,
    run: async (c) => {
      const user = await userArg(c, c.args[0]);
      if (!state().premium[user.id]) fail("That user does not have premium.");
      delete state().premium[user.id];
      for (const [gid, p] of Object.entries<Bag>(state().premiumGuilds)) if (p.userId === user.id) delete state().premiumGuilds[gid];
      save();
      await ownerLog(`Premium removed: ${user.tag}`);
      const note = await c.dm(user.id, "Premium Revoked", "Your **Premium** access has been removed and your activated servers were deactivated.");
      await c.reply(`Removed premium from ${user} and deactivated their servers.${note}`);
    },
  },
  pactivate: {
    level: 2,
    run: async (c) => {
      const guild = guildArg(c, c.args[0]);
      const user = await userArg(c, c.args[1]);
      const prem = state().premium[user.id] as Bag | undefined;
      if (!prem) fail("That user does not have premium.");
      if (state().premiumGuilds[guild.id]) fail("That server already has premium.");
      const used = Object.values<Bag>(state().premiumGuilds).filter((p) => p.userId === user.id).length;
      if (used >= prem!.slots) fail(`${user.tag} has used all **${prem!.slots}** slot${prem!.slots === 1 ? "" : "s"}.`);
      state().premiumGuilds[guild.id] = { userId: user.id, at: Date.now() };
      save();
      await ownerLog(`Premium activated in ${guild.name} (\`${guild.id}\`) by ${user.tag}`);
      await c.reply(`Activated premium in **${guild.name}** using ${user}'s slot (${used + 1}/${prem!.slots}).`);
    },
  },
  premiumdeactivate: {
    level: 2,
    run: async (c) => {
      if (!isId(c.args[0]) || !state().premiumGuilds[c.args[0]]) fail("That server does not have premium.");
      delete state().premiumGuilds[c.args[0]];
      save();
      await c.reply(`Deactivated premium in \`${c.args[0]}\`.`);
    },
  },

  /* 4. no-prefix */
  noprefix: {
    level: 2,
    sub: { list: 1 },
    run: async (c) => {
      const sub = c.args[0]?.toLowerCase();
      const np = state().noprefix as Bag;
      if (sub === "list") {
        const rows = Object.entries<Bag>(np).map(([id, e]) => `<@${id}> - ${whenText(e.expiresAt)}`);
        await c.reply(rows.join("\n") || "Nobody has no-prefix access.", "No-prefix users");
      } else if (sub === "add") {
        const user = await userArg(c, c.args[1]);
        const d = c.args[2] ? parseDur(c.args[2]) : null;
        if (d === undefined) fail("Use a duration like `7d`, or `perm`.");
        np[user.id] = { expiresAt: until(d as number | null) };
        save();
        const note = await c.dm(user.id, "No-Prefix Access Granted", `You can now use commands **without a prefix**. ${accessText(np[user.id].expiresAt)}`);
        await c.reply(`Gave ${user} no-prefix access (${whenText(np[user.id].expiresAt)}).${note}`);
      } else if (sub === "remove") {
        const user = await userArg(c, c.args[1]);
        if (!np[user.id]) fail("That user does not have no-prefix access.");
        delete np[user.id];
        save();
        const note = await c.dm(user.id, "No-Prefix Access Revoked", "Your no-prefix access has been removed. Commands need the prefix again.");
        await c.reply(`Removed no-prefix access from ${user}.${note}`);
      } else fail("Usage: `.noprefix <add|remove|list> [@user] [duration]`");
    },
  },
  garib: {
    level: 2,
    run: async (c) => {
      const user = await userArg(c, c.args[0]);
      const d = c.args[1] ? parseDur(c.args[1]) : 86_400_000;
      if (d === undefined) fail("Use a duration like `3d`, or `perm`.");
      state().noprefix[user.id] = { expiresAt: until(d as number | null) };
      save();
      const note = await c.dm(user.id, "No-Prefix Access Granted", `You can now use commands **without a prefix**. ${accessText(state().noprefix[user.id].expiresAt)}`);
      await c.reply(`Gave ${user} no-prefix access (${whenText(state().noprefix[user.id].expiresAt)}).${note}`);
    },
  },
  noprefixtrial: {
    level: 2,
    run: async (c) => {
      if (c.args[0]?.toLowerCase() !== "setup") fail(`Usage: \`${c.prefix}noprefixtrial setup [duration]\`, for example \`${c.prefix}noprefixtrial setup 7d\``);
      const d = c.args[1] ? parseDur(c.args[1]) : 14 * 86_400_000;
      if (!d) fail("Use a duration like `7d` or `14d`.");
      state().trial.durationMs = d;
      save();
      const days = longDuration(d as number);
      const button = new ButtonBuilder().setCustomId("npt:claim").setLabel(`Claim No-Prefix (${days})`).setStyle(ButtonStyle.Primary);
      const panel = new ContainerBuilder()
        .setAccentColor(WHITE)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("# Get No-Prefix Access (Free Trial)"))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Claim your free no-prefix access for **${days}** \u2014 type commands without any prefix.`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# \u2022 You can claim this once\n-# \u2022 Access expires automatically"))
        .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(button));
      await (c.message.channel as TextChannel).send({ components: [panel], flags: MessageFlags.IsComponentsV2 });
    },
  },

  /* 5. branding, badges, ship images */
  branding: {
    level: 3,
    run: async (c) => {
      const sub = c.args[0]?.toLowerCase();
      const user = c.client.user!;
      const b = state().branding as Bag;
      const https = (u?: string) => (u && /^https:\/\/\S+$/.test(u) ? u : fail("Give a valid https URL."));
      if (!sub) {
        const fresh = await user.fetch(true).catch(() => user);
        const app = await c.client.application?.fetch().catch(() => null);
        const card = embed(`**Name:** ${user.username}\n**Bio:** ${app?.description || "Not set"}\n**Banner:** ${fresh.bannerURL() ? "Set" : "Not set"}\n**Saved for servers:** avatar ${b.avatar ? "yes" : "no"}, banner ${b.banner ? "yes" : "no"}, bio ${b.bio ? "yes" : "no"}`, "Branding").setThumbnail(user.displayAvatarURL());
        if (fresh.bannerURL()) card.setImage(fresh.bannerURL()!);
        await c.message.reply({ embeds: [card], allowedMentions: { parse: [] } });
      } else if (sub === "avatar") {
        const url = https(c.args[1]);
        await user.setAvatar(url).catch(() => fail("Discord rejected that avatar (rate limit or bad image)."));
        b.avatar = url; save();
        await c.reply("Updated the bot avatar.");
      } else if (sub === "banner") {
        const url = https(c.args[1]);
        await user.setBanner(url).catch(() => fail("Discord rejected that banner (rate limit or bad image)."));
        b.banner = url; save();
        await c.reply("Updated the bot banner.");
      } else if (sub === "bio") {
        const text = c.args.slice(1).join(" ").slice(0, 400);
        if (!text) fail("Usage: `.branding bio <text>`");
        await c.client.application?.edit({ description: text });
        b.bio = text; save();
        await c.reply("Updated the bot bio.");
      } else if (sub === "server") {
        if (!c.message.guildId) fail("Run this inside a server.");
        if (!b.avatar && !b.banner && !b.bio) fail("Set an avatar, banner or bio first.");
        const dataUri = async (url: string) => {
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          const type = res.headers.get("content-type") ?? "image/png";
          return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
        };
        const body: Bag = {};
        if (b.avatar) body.avatar = await dataUri(b.avatar).catch(() => undefined);
        if (b.banner) body.banner = await dataUri(b.banner).catch(() => undefined);
        if (b.bio) body.bio = b.bio;
        await c.client.rest.patch(`/guilds/${c.message.guildId}/members/@me`, { body }).catch(() => fail("Discord rejected the server profile update."));
        await c.reply("Applied the saved branding to this server's bot profile.");
      } else if (sub === "reset") {
        await user.setAvatar(null).catch(() => undefined);
        await user.setBanner(null).catch(() => undefined);
        await c.client.application?.edit({ description: "" }).catch(() => undefined);
        state().branding = {}; save();
        await c.reply("Reset the bot branding.");
      } else fail("Usage: `.branding [avatar|banner|bio|server|reset]`");
    },
  },
  badge: {
    level: 2,
    sub: { list: 1 },
    run: async (c) => {
      const sub = c.args[0]?.toLowerCase();
      if (sub === "list") {
        if (c.args[1]) {
          const user = await userArg(c, c.args[1]);
          const badges = (userData(user.id).badges ?? []) as Bag[];
          await c.reply(badges.map((b) => `${b.emoji ?? ""} ${b.name}`.trim()).join("\n") || "No badges.", `${user.username}'s badges`);
        } else {
          const rows = Object.entries(allUsers()).filter(([, bag]) => (bag.badges ?? []).length).map(([id, bag]) => `<@${id}>: ${(bag.badges as Bag[]).map((b) => `${b.emoji ?? ""}${b.name}`).join(", ")}`);
          await c.reply(rows.join("\n") || "Nobody has badges.", "Badge holders");
        }
        return;
      }
      const user = await userArg(c, c.args[1]);
      const name = c.args[2];
      if ((sub !== "add" && sub !== "remove") || !name) fail("Usage: `.badge <add|remove> @user <name> [emoji]` or `.badge list [@user]`");
      const bag = userData(user.id);
      const badges = ((bag.badges ??= []) as Bag[]);
      if (sub === "add") {
        const emoji = c.args[3];
        const existing = badges.find((b) => b.name.toLowerCase() === name.toLowerCase());
        if (existing) existing.emoji = emoji ?? existing.emoji; else badges.push({ name, emoji });
        await c.reply(`Gave ${user} the **${name}** badge.`);
      } else {
        const before = badges.length;
        bag.badges = badges.filter((b) => b.name.toLowerCase() !== name.toLowerCase());
        if (bag.badges.length === before) fail("They do not have that badge.");
        await c.reply(`Removed the **${name}** badge from ${user}.`);
      }
      save();
    },
  },
  shipimages: {
    level: 2,
    sub: { list: 1 },
    run: async (c) => {
      const sub = c.args[0]?.toLowerCase();
      const images = state().shipImages as string[];
      if (sub === "list") {
        await c.reply(images.map((u, i) => `**${i + 1}.** ${u}`).join("\n") || "No ship images.", "Ship images");
      } else if (sub === "add") {
        const urls = [...c.message.attachments.values()].map((a) => a.url).concat(c.args.slice(1).filter((a) => /^https:\/\/\S+$/.test(a)));
        if (!urls.length) fail("Attach an image or give an https URL.");
        state().shipImages = [...new Set([...images, ...urls])];
        save();
        await c.reply(`Added **${urls.length}** ship image${urls.length === 1 ? "" : "s"}.`);
      } else if (sub === "remove") {
        const n = Number(c.args[1]);
        const target = Number.isInteger(n) ? images[n - 1] : c.args[1];
        if (!target || !images.includes(target)) fail("Give the number from `.shipimages list`, or the exact URL.");
        state().shipImages = images.filter((u) => u !== target);
        save();
        await c.reply("Removed the ship image.");
      } else fail("Usage: `.shipimages <add|remove|list>`");
    },
  },

  /* 6. staff */
  addadmin: { level: 3, run: (c) => staffEdit(c, "admins", true, "an admin") },
  removeadmin: { level: 3, run: (c) => staffEdit(c, "admins", false, "an admin") },
  adddev: { level: 3, run: (c) => staffEdit(c, "devs", true, "a developer") },
  removedev: { level: 3, run: (c) => staffEdit(c, "devs", false, "a developer") },
  stafflist: {
    level: 1,
    run: async (c) => {
      const s = staffLists();
      const fmt = (ids: string[]) => ids.map((id) => `<@${id}>`).join(", ") || "None";
      await c.reply(`**Owners**\n${fmt(s.owners)}\n\n**Developers**\n${fmt(s.devs)}\n\n**Core team**\n${fmt(s.core)}\n\n**Admins**\n${fmt(s.admins)}`, "Staff");
    },
  },
  team: {
    level: 3,
    run: async (c) => {
      const [group, action] = [c.args[0]?.toLowerCase(), c.args[1]?.toLowerCase()];
      if ((group !== "developers" && group !== "core") || (action !== "add" && action !== "remove")) fail("Usage: `.team <developers|core> <add|remove> @user`");
      await staffEdit({ ...c, args: [c.args[2]] }, group === "developers" ? "devs" : "core", action === "add", group === "developers" ? "a developer" : "core team");
    },
  },

  /* 7. logs */
  logchannel: {
    level: 3,
    run: async (c) => {
      const sub = c.args[0]?.toLowerCase();
      if (sub === "set") {
        if (!WEBHOOK.test(c.args[1] ?? "")) fail("Give a valid Discord webhook URL.");
        state().logWebhook = c.args[1];
        save();
        await ownerLog("Owner log channel connected.");
        await c.reply("Saved the log webhook and sent a test message.");
        await c.message.delete().catch(() => undefined); // hide the webhook URL
      } else if (sub === "disable") {
        delete state().logWebhook;
        save();
        await c.reply("Disabled owner logging.");
      } else fail("Usage: `.logchannel set <webhook URL>` or `.logchannel disable`");
    },
  },

  /* 8. database */
  hydrate: {
    level: 3,
    run: async (c) => {
      const n = reloadStore();
      await c.reply(`Reloaded the database from disk: **${n.guilds}** servers, **${n.users}** users.`);
    },
  },
  flush: {
    level: 3,
    run: async (c) => {
      const n = flushNow();
      await c.reply(`Wrote the database to disk: **${n.guilds}** servers, **${n.users}** users.`);
    },
  },

  dm: {
    level: 2,
    run: async (c) => {
      const user = await userArg(c, c.args[0]);
      const text = c.args.slice(1).join(" ");
      if (!text) fail(`Usage: \`${c.prefix}dm @user <message>\``);
      const ok = await dmEmbed(c.client, user.id, "Message from the team", text);
      if (!ok) fail("I could not DM that user. They may have DMs closed.");
      await c.reply(`Sent ${user} a DM.`);
    },
  },

  /* 9. voting */
  recordvote: {
    level: 2,
    run: async (c) => {
      const user = await userArg(c, c.args[0]);
      const weight = c.args[1] ? Number(c.args[1]) : 1;
      if (!Number.isFinite(weight) || weight <= 0 || weight > 10) fail("The weight must be between 0 and 10.");
      const v = (state().votes[user.id] ??= { count: 0, weight: 0 }) as Bag;
      v.count += 1; v.weight += weight; v.last = Date.now();
      const eco = ((userData(user.id).eco ??= { wallet: 0, bank: 0, cooldowns: {} }) as Bag);
      const reward = Math.round(500 * weight);
      eco.wallet += reward;
      save();
      await user.send(`Thanks for voting! You received **${reward.toLocaleString("en-US")} Dallars**.`).catch(() => undefined);
      await ownerLog(`Vote recorded for ${user.tag} (weight ${weight}).`);
      await c.reply(`Recorded vote #${v.count} for ${user} (weight ${weight}, reward ${reward.toLocaleString("en-US")} Dallars).`);
    },
  },

  /* 10. system */
  reboot: {
    level: 3,
    run: async (c) => {
      await c.reply("Rebooting. The bot will be back shortly if it runs under a process manager (Render restarts it automatically).");
      await ownerLog(`Reboot requested by <@${c.message.author.id}>.`);
      flushNow();
      setTimeout(() => process.exit(0), 1000);
    },
  },
};

async function staffEdit(c: OCtx, list: "admins" | "devs" | "core", add: boolean, label: string): Promise<void> {
  const user = await userArg(c, c.args[0]);
  const s = state().staff as Bag;
  if (accessLevel(user.id) === 3) fail("That user is already an owner.");
  s[list] = onOff(s[list], user.id, add);
  save();
  await ownerLog(`${add ? "Added" : "Removed"} ${user.tag} ${add ? "as" : "from"} ${label}.`);
  await c.reply(`${add ? "Made" : "Removed"} ${user} ${add ? "" : "as "}${label}${add ? "." : "."}`.replace("Made ", "Made ").replace("Removed ", "Removed "));
}

/* ---------- entry points used by bot.ts ---------- */
export async function handleOwnerCommand(client: Client, message: Message): Promise<boolean> {
  const used = matchPrefix(message);
  if (!used) return false;
  const level = accessLevel(message.author.id);
  if (level === 0) return false;
  const tokens = used.rest.trim().split(/\s+/);
  const name = tokens[0]?.toLowerCase() ?? "";
  const nodm = tokens.includes("--nodm");
  const args = tokens.slice(1).filter((t) => t !== "--nodm");
  const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!cmd) return false;

  const prefix = used.prefix;
  const fixPrefix = (text: string) => text.replace(/`\.(?=[a-z])/g, `\`${prefix}`);
  const need = cmd.sub?.[args[0]?.toLowerCase() ?? ""] ?? cmd.level;
  const ctx: OCtx = {
    client,
    message,
    args,
    raw: args.join(" "),
    prefix,
    reply: (text, title) => message.reply({ embeds: [embed(fixPrefix(text), title)], allowedMentions: { parse: [] } }),
    dm: async (userId, title, text) => {
      if (nodm) return "";
      return (await dmEmbed(client, userId, title, text)) ? " DM sent." : " Their DMs are closed, so no DM was sent.";
    },
  };
  if (level < need) {
    await ctx.reply(`This needs **${["", "admin", "developer", "owner"][need]}** access.`);
    return true;
  }
  try {
    await cmd.run(ctx);
    if (name !== "ownerhelp") void ownerLog(`<@${message.author.id}> ran \`${prefix}${name} ${args.join(" ").slice(0, 120)}\``);
  } catch (error) {
    if (error instanceof OwnerError) await ctx.reply(error.message);
    else {
      logger.error({ err: error, command: name }, "Owner command failed");
      await ctx.reply("Something went wrong while running that command.");
    }
  }
  return true;
}

/** True when this message should be ignored (global ban or blacklisted server). */
export function isBlocked(message: Message): boolean {
  if (accessLevel(message.author.id) > 0) return false;
  const s = state();
  return Boolean(s.globalBans[message.author.id] || (message.guildId && s.blacklist[message.guildId]));
}

/** Lets a message without the prefix run when the user or server has no-prefix access. */
export function noPrefixAllowed(message: Message): boolean {
  if (!message.inGuild()) return false;
  const s = state();
  const entry = s.noprefix[message.author.id] as Bag | undefined;
  const userOk = entry && (entry.expiresAt === null || entry.expiresAt > Date.now());
  if (!userOk && !(s.guildNP as string[]).includes(message.guildId)) return false;
  const first = message.content.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return ["help", "commands", "botinfo"].includes(first) || Boolean(resolveCommand(message.content));
}

export function startOwnerSystem(client: Client): void {
  const leaveIfBanned = (guild: Guild) => {
    const s = state();
    if (s.blacklist[guild.id] || s.serverBans[guild.id]) void guild.leave().catch(() => undefined);
  };
  client.on(Events.GuildCreate, (guild) => {
    leaveIfBanned(guild);
    void ownerLog(`Joined **${guild.name}** (\`${guild.id}\`) - ${guild.memberCount} members.`);
  });
  client.on(Events.GuildDelete, (guild) => void ownerLog(`Left **${guild.name ?? "a server"}** (\`${guild.id}\`).`));
  client.once(Events.ClientReady, () => client.guilds.cache.forEach(leaveIfBanned));

  client.on(Events.InteractionCreate, (i) => {
    if (!i.isButton() || i.customId !== "npt:claim") return;
    void (async () => {
      const s = state();
      if (s.trial.claimed[i.user.id]) return void (await i.reply({ content: "You already claimed your trial.", flags: MessageFlags.Ephemeral }));
      const existing = s.noprefix[i.user.id] as Bag | undefined;
      if (existing && existing.expiresAt === null) return void (await i.reply({ content: "You already have permanent no-prefix access.", flags: MessageFlags.Ephemeral }));
      s.trial.claimed[i.user.id] = Date.now();
      s.noprefix[i.user.id] = { expiresAt: Date.now() + s.trial.durationMs, trial: true };
      save();
      await i.reply({ content: `Trial started. You can use commands without the prefix for **${longDuration(s.trial.durationMs)}**.`, flags: MessageFlags.Ephemeral });
      void dmEmbed(client, i.user.id, "No-Prefix Access Granted", `Your free trial is active. ${accessText(s.noprefix[i.user.id].expiresAt)}`);
    })().catch((err: unknown) => logger.error({ err }, "No-prefix trial failed"));
  });

  setInterval(() => {
    const s = state();
    let changed = false;
    for (const [id, e] of Object.entries<Bag>(s.noprefix)) {
      if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
        delete s.noprefix[id];
        changed = true;
        void dmEmbed(client, id, "No-Prefix Access Expired", "Your no-prefix access has ended. Commands need the prefix again.");
      }
    }
    for (const [id, p] of Object.entries<Bag>(s.premium)) {
      if (p.expiresAt !== null && p.expiresAt <= Date.now()) {
        delete s.premium[id];
        for (const [gid, pg] of Object.entries<Bag>(s.premiumGuilds)) if (pg.userId === id) delete s.premiumGuilds[gid];
        changed = true;
        void dmEmbed(client, id, "Premium Expired", "Your **Premium** access has ended and your activated servers were deactivated.");
      }
    }
    if (changed) save();
  }, 60_000).unref();
}
