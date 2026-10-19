import { EmbedBuilder, type Client, type Guild, type GuildBasedChannel, type Message, type User } from "discord.js";
import { logger } from "../../../lib/logger";
import { guildData, save, userData } from "../../store";
import { parseChannel, parseMember, parseRole } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { WHITE, embed } from "../ui";
import { renderTemplate } from "./render";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bag = Record<string, any>;
const greet = (g: string): Bag => (guildData(g).greet ??= { welcome: {}, goodbye: {}, boost: {}, joindm: {}, ping: {}, sticky: {}, rr: {} });

function sendable(ch: GuildBasedChannel | null | undefined) {
  return ch?.isTextBased() && "send" in ch ? ch : null;
}
async function textChannelArg(ctx: Ctx, token = ctx.args[0]) {
  const ch = sendable(parseChannel(ctx, token));
  if (!ch) throw new CommandError("I could not find that text channel.");
  return ch;
}
const send = (ch: GuildBasedChannel | undefined | null, text: string, user: User, guild: Guild) => {
  const target = sendable(ch ?? undefined);
  return target?.send({ content: renderTemplate(text, user, guild), allowedMentions: { users: [user.id] } }).catch(() => undefined);
};

/* ---------- welcome ---------- */
const DEFAULT_WELCOME = "Welcome {user.mention} to **{server}**! You are member #{membercount}.";
const WELCOME_HANDLERS: Record<string, Handler> = {
  "welcome setup": async (ctx) => {
    const ch = await textChannelArg(ctx);
    greet(ctx.guild.id).welcome[ch.id] = { text: ctx.args.slice(1).join(" ") || DEFAULT_WELCOME };
    save();
    await ctx.ok(`Greet message set for ${ch}.`);
  },
  "welcome unset": async (ctx) => {
    const ch = await textChannelArg(ctx);
    delete greet(ctx.guild.id).welcome[ch.id];
    save();
    await ctx.ok(`Removed the greet message for ${ch}.`);
  },
  "welcome view": async (ctx) => {
    const ch = await textChannelArg(ctx);
    const entry = greet(ctx.guild.id).welcome[ch.id];
    if (!entry) throw new CommandError("That channel has no greet message.");
    await ctx.reply(embed(renderTemplate(entry.text, ctx.member.user, ctx.guild), "Preview"));
  },
  "welcome list": async (ctx) => {
    const ids = Object.keys(greet(ctx.guild.id).welcome);
    await ctx.reply(embed(ids.map((id) => `<#${id}>`).join("\n") || "No greet messages configured.", "Greet channels"));
  },
  "welcome clear": async (ctx) => {
    greet(ctx.guild.id).welcome = {};
    save();
    await ctx.ok("Removed every greet message.");
  },
  "welcome default": async (ctx) => {
    const ch = await textChannelArg(ctx);
    const on = ["on", "true", "yes", "enable"].includes((ctx.args[1] ?? "").toLowerCase());
    const entry = greet(ctx.guild.id).welcome[ch.id];
    if (!entry) throw new CommandError("Set up a greet message for that channel first.");
    entry.defaultSticker = on;
    save();
    await ctx.ok(`Default wave sticker ${on ? "enabled" : "disabled"} for ${ch}.`);
  },
};

/* ---------- goodbye + boost (same shape) ---------- */
function singleMessage(root: "goodbye" | "boost", fallback: string, event: string): Record<string, Handler> {
  const cfg = (ctx: Ctx) => greet(ctx.guild.id)[root];
  return {
    [`${root} set`]: async (ctx) => {
      const ch = await textChannelArg(ctx);
      const c = cfg(ctx);
      c.channel = ch.id;
      c.text ??= fallback;
      save();
      await ctx.ok(`The ${root} message will be sent in ${ch}.`);
    },
    [`${root} message`]: async (ctx) => {
      cfg(ctx).text = ctx.raw.slice(0, 1500);
      save();
      await ctx.ok(`Updated the ${root} message.`);
    },
    [`${root} message clear`]: async (ctx) => {
      cfg(ctx).text = fallback;
      save();
      await ctx.ok(`Reset the ${root} message to the default.`);
    },
    [`${root} message view`]: async (ctx) => {
      await ctx.reply(embed(renderTemplate(cfg(ctx).text ?? fallback, ctx.member.user, ctx.guild), "Preview"));
    },
    [`${root} settings`]: async (ctx) => {
      const c = cfg(ctx);
      await ctx.reply(embed(`**Channel:** ${c.channel ? `<#${c.channel}>` : "Not set"}\n**Message:** ${c.text ?? fallback}`, `${root} settings`));
    },
    [`${root} test`]: async (ctx) => {
      const c = cfg(ctx);
      const ch = ctx.args[0] ? await textChannelArg(ctx) : sendable(ctx.guild.channels.cache.get(c.channel ?? ""));
      if (!ch) throw new CommandError(`Set a channel first with \`${ctx.prefix}${root} set (channel)\`.`);
      await send(ch as never, c.text ?? fallback, ctx.member.user, ctx.guild);
      await ctx.ok(`Sent a test ${event} message.`);
    },
    [`${root} remove`]: async (ctx) => {
      greet(ctx.guild.id)[root] = {};
      save();
      await ctx.ok(`Removed all ${root} settings.`);
    },
  };
}

/* ---------- join dm + ping on join ---------- */
const JOIN_DM_DEFAULT = "Welcome to **{server}**, {user.name}!";
const MISC_HANDLERS: Record<string, Handler> = {
  "joindm enable": async (ctx) => { greet(ctx.guild.id).joindm.enabled = true; save(); await ctx.ok("Join DMs are enabled."); },
  "joindm disable": async (ctx) => { greet(ctx.guild.id).joindm.enabled = false; save(); await ctx.ok("Join DMs are disabled."); },
  "joindm message": async (ctx) => { greet(ctx.guild.id).joindm.text = ctx.raw.slice(0, 1500); save(); await ctx.ok("Updated the join DM message."); },
  "joindm message clear": async (ctx) => { greet(ctx.guild.id).joindm.text = undefined; save(); await ctx.ok("Reset the join DM message."); },
  "joindm message view": async (ctx) => {
    await ctx.reply(embed(renderTemplate(greet(ctx.guild.id).joindm.text ?? JOIN_DM_DEFAULT, ctx.member.user, ctx.guild), "Preview"));
  },
  "pingonjoin add": async (ctx) => {
    const ch = await textChannelArg(ctx);
    greet(ctx.guild.id).ping.channel = ch.id;
    save();
    await ctx.ok(`New members will be pinged in ${ch}.`);
  },
  "pingonjoin edit": async (ctx) => { greet(ctx.guild.id).ping.text = ctx.raw.slice(0, 500); save(); await ctx.ok("Updated the join ping message."); },
  "pingonjoin clear": async (ctx) => { greet(ctx.guild.id).ping.text = undefined; save(); await ctx.ok("Reset the join ping to a plain mention."); },
  "pingonjoin remove": async (ctx) => { greet(ctx.guild.id).ping = {}; save(); await ctx.ok("Disabled join pings."); },
  "pingonjoin onboarding": async (ctx) => {
    const on = ["on", "true", "yes", "enable"].includes(ctx.args[0].toLowerCase());
    greet(ctx.guild.id).ping.onboarding = on;
    save();
    await ctx.ok(`Join pings ${on ? "now wait" : "no longer wait"} for onboarding to finish.`);
  },
  "pingonjoin view": async (ctx) => {
    const p = greet(ctx.guild.id).ping;
    await ctx.reply(embed(`**Channel:** ${p.channel ? `<#${p.channel}>` : "Not set"}\n**Message:** ${p.text ?? "{user.mention}"}\n**Wait for onboarding:** ${p.onboarding ? "Yes" : "No"}`, "Ping on join"));
  },
};

/* ---------- sticky messages ---------- */
const STICKY_HANDLERS: Record<string, Handler> = {
  "stickymessage add": async (ctx) => {
    const ch = await textChannelArg(ctx);
    const text = ctx.args.slice(1).join(" ");
    if (!text) throw new UsageError();
    greet(ctx.guild.id).sticky[ch.id] = { text: text.slice(0, 1800) };
    save();
    await ch.send({ content: text.slice(0, 1800) }).then((m) => { greet(ctx.guild.id).sticky[ch.id].last = m.id; save(); }).catch(() => undefined);
    await ctx.ok(`Sticky message set in ${ch}.`);
  },
  "stickymessage remove": async (ctx) => {
    const ch = await textChannelArg(ctx);
    delete greet(ctx.guild.id).sticky[ch.id];
    save();
    await ctx.ok(`Removed the sticky message from ${ch}.`);
  },
  "stickymessage list": async (ctx) => {
    const lines = Object.entries(greet(ctx.guild.id).sticky).map(([id, s]: [string, any]) => `<#${id}>: ${s.text.slice(0, 60)}`);
    await ctx.reply(embed(lines.join("\n") || "No sticky messages.", "Sticky messages"));
  },
};

/* ---------- reaction roles ---------- */
const emojiKey = (token: string) => token.match(/^<a?:\w+:(\d+)>$/)?.[1] ?? token;

async function findMessage(ctx: Ctx, token: string): Promise<Message | null> {
  const link = token.match(/channels\/\d+\/(\d+)\/(\d+)/);
  const channel = link ? ctx.guild.channels.cache.get(link[1]) : ctx.message.channel;
  const id = link ? link[2] : token;
  return channel?.isTextBased() ? channel.messages.fetch(id).catch(() => null) : null;
}
const rr = (g: string): Record<string, { channelId: string; map: Record<string, string> }> => greet(g).rr;

const REACTION_ROLE_HANDLERS: Record<string, Handler> = {
  "reactionrole add": async (ctx) => {
    const message = await findMessage(ctx, ctx.args[0]);
    const role = parseRole(ctx, ctx.args.slice(2).join(" "));
    if (!message) throw new CommandError("I could not find that message. Use a message ID from this channel or a link.");
    if (!role) throw new CommandError("I could not find that role.");
    await message.react(ctx.args[1]).catch(() => { throw new CommandError("I could not use that emoji."); });
    const entry = (rr(ctx.guild.id)[message.id] ??= { channelId: message.channelId, map: {} });
    entry.map[emojiKey(ctx.args[1])] = role.id;
    save();
    await ctx.ok(`Reacting with ${ctx.args[1]} now gives ${role}.`);
  },
  "reactionrole remove": async (ctx) => {
    const message = await findMessage(ctx, ctx.args[0]);
    const entry = message && rr(ctx.guild.id)[message.id];
    if (!entry || !(emojiKey(ctx.args[1]) in entry.map)) throw new CommandError("That reaction role does not exist.");
    delete entry.map[emojiKey(ctx.args[1])];
    save();
    await ctx.ok("Removed the reaction role.");
  },
  "reactionrole removeall": async (ctx) => {
    const message = await findMessage(ctx, ctx.args[0]);
    if (!message) throw new CommandError("I could not find that message.");
    delete rr(ctx.guild.id)[message.id];
    save();
    await ctx.ok("Removed every reaction role from that message.");
  },
  "reactionrole list": async (ctx) => {
    const lines = Object.entries(rr(ctx.guild.id)).flatMap(([id, e]) => Object.entries(e.map).map(([k, role]) => `\`${id}\` ${/^\d+$/.test(k) ? `<:e:${k}>` : k} -> <@&${role}>`));
    await ctx.reply(embed(lines.join("\n") || "No reaction roles.", "Reaction roles"));
  },
  "reactionrole clear": async (ctx) => { greet(ctx.guild.id).rr = {}; save(); await ctx.ok("Removed all reaction roles."); },
};

/* ---------- polls, timezone, suggestions ---------- */
const NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
async function poll(ctx: Ctx, yesNo: boolean): Promise<void> {
  const parts = ctx.raw.split("|").map((s) => s.trim()).filter(Boolean);
  const [question, ...options] = parts;
  const choices = yesNo || options.length < 2 ? [] : options.slice(0, 9);
  const body = choices.length ? choices.map((o, i) => `${NUMBERS[i]} ${o}`).join("\n") : "React with 👍 or 👎.";
  const sent = await ctx.message.channel.send({ embeds: [embed(body, question)] });
  for (const e of choices.length ? NUMBERS.slice(0, choices.length) : ["👍", "👎"]) await sent.react(e).catch(() => undefined);
}

const isZone = (tz: string) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };
const clock = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date());

interface Suggestion { channelId: string; messageId: string; text: string; authorId: string; status: string }
const sug = (g: string): Bag => (guildData(g).suggest ??= { enabled: true, anonymous: false, thread: false, count: 0, items: {} });

async function decide(ctx: Ctx, status: string, color: number): Promise<void> {
  const id = ctx.args[0];
  const s: Suggestion | undefined = sug(ctx.guild.id).items[id];
  if (!s) throw new CommandError("I could not find that suggestion.");
  s.status = status;
  const reason = ctx.args.slice(1).join(" ");
  const channel = ctx.guild.channels.cache.get(s.channelId);
  const message = channel?.isTextBased() ? await channel.messages.fetch(s.messageId).catch(() => null) : null;
  if (message) {
    const card = EmbedBuilder.from(message.embeds[0]).setColor(color).setFooter({ text: `${status}${reason ? `: ${reason}` : ""}` });
    await message.edit({ embeds: [card] });
  }
  save();
  await ctx.ok(`Marked suggestion #${id} as ${status.toLowerCase()}.`);
}

const COMMUNITY_HANDLERS: Record<string, Handler> = {
  poll: (ctx) => poll(ctx, false),
  quickpoll: (ctx) => poll(ctx, true),
  "timezone set": async (ctx) => {
    if (!isZone(ctx.args[0])) throw new CommandError("Use a valid timezone such as `America/New_York` or `Asia/Kolkata`.");
    userData(ctx.member.id).timezone = ctx.args[0];
    save();
    await ctx.ok(`Your timezone is now **${ctx.args[0]}** (${clock(ctx.args[0])}).`);
  },
  "timezone remove": async (ctx) => { delete userData(ctx.member.id).timezone; save(); await ctx.ok("Removed your timezone."); },
  timezone: async (ctx) => {
    const member = ctx.args[0] ? await parseMember(ctx, ctx.args[0]) : ctx.member;
    const tz = member && userData(member.id).timezone;
    if (!member || !tz) throw new CommandError(`${member ? "They have" : "That member does not have"} no timezone set.`);
    await ctx.ok(`It is **${clock(tz)}** for ${member} (${tz}).`);
  },
  "suggest channel": async (ctx) => { sug(ctx.guild.id).channel = (await textChannelArg(ctx)).id; save(); await ctx.ok("Suggestions will be posted there."); },
  "suggest enable": async (ctx) => { sug(ctx.guild.id).enabled = true; save(); await ctx.ok("Suggestions are enabled."); },
  "suggest disable": async (ctx) => { sug(ctx.guild.id).enabled = false; save(); await ctx.ok("Suggestions are disabled."); },
  "suggest reset": async (ctx) => { delete guildData(ctx.guild.id).suggest; save(); await ctx.ok("Reset the suggestions setup."); },
  "suggest anonymous": async (ctx) => {
    const s = sug(ctx.guild.id);
    s.anonymous = ctx.args[0] ? ["on", "true", "yes"].includes(ctx.args[0].toLowerCase()) : !s.anonymous;
    save();
    await ctx.ok(`Anonymous suggestions are ${s.anonymous ? "on" : "off"}.`);
  },
  "suggest thread": async (ctx) => {
    const s = sug(ctx.guild.id);
    s.thread = ctx.args[0] ? ["on", "true", "yes"].includes(ctx.args[0].toLowerCase()) : !s.thread;
    save();
    await ctx.ok(`Suggestion threads are ${s.thread ? "on" : "off"}.`);
  },
  "suggest approve": (ctx) => decide(ctx, "Approved", 0x57f287),
  "suggest deny": (ctx) => decide(ctx, "Denied", 0xed4245),
  "suggest consider": (ctx) => decide(ctx, "Under consideration", 0xfee75c),
  suggest: async (ctx) => {
    const s = sug(ctx.guild.id);
    const channel = sendable(ctx.guild.channels.cache.get(s.channel ?? ""));
    if (!s.enabled || !channel) throw new CommandError("Suggestions are not set up in this server.");
    s.count += 1;
    const card = new EmbedBuilder().setColor(WHITE).setTitle(`Suggestion #${s.count}`).setDescription(ctx.raw.slice(0, 3500));
    if (!s.anonymous) card.setAuthor({ name: ctx.member.user.tag, iconURL: ctx.member.displayAvatarURL() });
    const posted = await channel.send({ embeds: [card] });
    await posted.react("👍").catch(() => undefined);
    await posted.react("👎").catch(() => undefined);
    if (s.thread) await posted.startThread({ name: `Suggestion ${s.count}` }).catch(() => undefined);
    s.items[String(s.count)] = { channelId: channel.id, messageId: posted.id, text: ctx.raw, authorId: ctx.member.id, status: "Pending" } satisfies Suggestion;
    save();
    await ctx.ok(`Posted your suggestion as #${s.count}.`);
  },
};

export const GREETING_HANDLERS: Record<string, Handler> = {
  ...WELCOME_HANDLERS,
  ...singleMessage("goodbye", "{user.name} has left **{server}**.", "goodbye"),
  ...singleMessage("boost", "Thank you {user.mention} for boosting **{server}**!", "boost"),
  ...MISC_HANDLERS,
  ...STICKY_HANDLERS,
  ...REACTION_ROLE_HANDLERS,
  ...COMMUNITY_HANDLERS,
};

/* ---------- listeners ---------- */
export function startGreetings(client: Client): void {
  const guard = (label: string, fn: () => Promise<void>) => void fn().catch((err: unknown) => logger.error({ err }, `${label} failed`));

  client.on("guildMemberAdd", (m) => guard("Welcome", async () => {
    const g = greet(m.guild.id);
    for (const [id, entry] of Object.entries<any>(g.welcome)) await send(m.guild.channels.cache.get(id), entry.text, m.user, m.guild);
    if (g.joindm.enabled) await m.send(renderTemplate(g.joindm.text ?? JOIN_DM_DEFAULT, m.user, m.guild)).catch(() => undefined);
    if (g.ping.channel && !(g.ping.onboarding && m.pending)) await pingJoin(m.guild, m.user);
  }));
  client.on("guildMemberUpdate", (before, after) => guard("Member update", async () => {
    const g = greet(after.guild.id);
    if (!before.premiumSince && after.premiumSince && g.boost.channel) await send(after.guild.channels.cache.get(g.boost.channel), g.boost.text ?? "Thank you {user.mention} for boosting **{server}**!", after.user, after.guild);
    if (before.pending && !after.pending && g.ping.channel && g.ping.onboarding) await pingJoin(after.guild, after.user);
  }));
  client.on("guildMemberRemove", (m) => guard("Goodbye", async () => {
    const g = greet(m.guild.id);
    if (g.goodbye.channel) await send(m.guild.channels.cache.get(g.goodbye.channel), g.goodbye.text ?? "{user.name} has left **{server}**.", m.user, m.guild);
  }));

  client.on("messageCreate", (m) => guard("Sticky", async () => {
    if (!m.inGuild() || m.author.id === client.user?.id) return;
    const entry = greet(m.guild.id).sticky[m.channelId];
    if (!entry) return;
    if (entry.last) await m.channel.messages.delete(entry.last).catch(() => undefined);
    const sent = await m.channel.send({ content: entry.text });
    entry.last = sent.id;
    save();
  }));

  const reaction = (add: boolean) => (r: any, user: User) => guard("Reaction role", async () => {
    if (user.bot) return;
    const reactionFull = r.partial ? await r.fetch() : r;
    const message = reactionFull.message;
    if (!message.guild) return;
    const entry = rr(message.guild.id)[message.id];
    const roleId = entry?.map[reactionFull.emoji.id ?? reactionFull.emoji.name];
    if (!roleId) return;
    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (add) await member?.roles.add(roleId, "Reaction role").catch(() => undefined);
    else await member?.roles.remove(roleId, "Reaction role").catch(() => undefined);
  });
  client.on("messageReactionAdd", reaction(true));
  client.on("messageReactionRemove", reaction(false));
}

async function pingJoin(guild: Guild, user: User): Promise<void> {
  const p = greet(guild.id).ping;
  const ch = sendable(guild.channels.cache.get(p.channel));
  const sent = await ch?.send({ content: renderTemplate(p.text ?? "{user.mention}", user, guild), allowedMentions: { users: [user.id] } }).catch(() => null);
  if (sent) setTimeout(() => void sent.delete().catch(() => undefined), 5000);
}
