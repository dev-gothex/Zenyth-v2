import { type Client, type Message } from "discord.js";
import { logger } from "../../../lib/logger";
import { guildData, save, userData, allUsers } from "../../store";
import { formatDuration, parseDuration } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
const split = (raw: string): [string, string] => {
  const quoted = raw.match(/^"([^"]+)"\s*([\s\S]*)$/);
  if (quoted) return [quoted[1], quoted[2]];
  const [first, ...rest] = raw.split(/\s+/);
  return [first ?? "", rest.join(" ")];
};

const responders = (g: string): Record<string, string> => (guildData(g).autoresponders ??= {});
const reacts = (g: string): Record<string, string[]> => (guildData(g).autoreacts ??= {});
const activity = (g: string): Record<string, { m: number; v: number }> =>
  ((guildData(g).activity ??= {}) as Record<string, { m: number; v: number }>);

function trigger(raw: string): [string, string] {
  const [t, rest] = split(raw);
  if (!t || !rest) throw new UsageError();
  return [t.toLowerCase(), rest];
}

const fmtTime = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

async function showStats(ctx: Ctx, userId: string, label: string): Promise<void> {
  const row = activity(ctx.guild.id)[userId] ?? { m: 0, v: 0 };
  await ctx.reply(embed(`**Messages:** ${row.m.toLocaleString("en-US")}\n**Voice time:** ${formatDuration(row.v)}`, label));
}

export const AUTOMATION_HANDLERS: Record<string, Handler> = {
  afk: async (ctx) => {
    const reason = ctx.raw.replace(/--\w+/g, "").trim().slice(0, 200) || "AFK";
    userData(ctx.member.id).afk = { reason, since: Date.now() };
    save();
    await ctx.ok(`You are now AFK: ${reason}`);
  },

  "autoresponder add": async (ctx) => {
    const [t, response] = trigger(ctx.raw);
    responders(ctx.guild.id)[t] = response;
    save();
    await ctx.ok(`Added an autoresponder for \`${t}\`.`);
  },
  "autoresponder update": async (ctx) => {
    const [t, response] = trigger(ctx.raw);
    if (!(t in responders(ctx.guild.id))) throw new CommandError("No autoresponder uses that trigger.");
    responders(ctx.guild.id)[t] = response;
    save();
    await ctx.ok(`Updated the autoresponder for \`${t}\`.`);
  },
  "autoresponder remove": async (ctx) => {
    const t = ctx.raw.toLowerCase().replace(/^"|"$/g, "");
    if (!(t in responders(ctx.guild.id))) throw new CommandError("No autoresponder uses that trigger.");
    delete responders(ctx.guild.id)[t];
    save();
    await ctx.ok(`Removed the autoresponder for \`${t}\`.`);
  },
  "autoresponder list": async (ctx) => {
    const lines = Object.entries(responders(ctx.guild.id)).map(([t, r]) => `\`${t}\` -> ${r.slice(0, 80)}`);
    await ctx.reply(embed(lines.join("\n") || "No autoresponders yet.", "Autoresponders"));
  },
  "autoresponder clear": async (ctx) => {
    guildData(ctx.guild.id).autoresponders = {};
    save();
    await ctx.ok("Cleared all autoresponders.");
  },

  "autoreact add": async (ctx) => {
    const [t, emojis] = trigger(ctx.raw);
    reacts(ctx.guild.id)[t] = emojis.split(/\s+/).filter(Boolean).slice(0, 5);
    save();
    await ctx.ok(`Added an autoreact for \`${t}\`.`);
  },
  "autoreact remove": async (ctx) => {
    const t = ctx.raw.toLowerCase();
    if (!(t in reacts(ctx.guild.id))) throw new CommandError("No autoreact uses that trigger.");
    delete reacts(ctx.guild.id)[t];
    save();
    await ctx.ok(`Removed the autoreact for \`${t}\`.`);
  },
  "autoreact list": async (ctx) => {
    const lines = Object.entries(reacts(ctx.guild.id)).map(([t, e]) => `\`${t}\` -> ${e.join(" ")}`);
    await ctx.reply(embed(lines.join("\n") || "No autoreacts yet.", "Autoreacts"));
  },
  "autoreact reset": async (ctx) => {
    guildData(ctx.guild.id).autoreacts = {};
    save();
    await ctx.ok("Removed all autoreacts.");
  },

  "reminder add": async (ctx) => {
    const ms = parseDuration(ctx.args[0]);
    const text = ctx.args.slice(1).join(" ");
    if (!ms || !text) throw new CommandError("Use a time like `10m` or `2h`, then the reminder text.");
    const bag = userData(ctx.member.id);
    (bag.reminders ??= []).push({ at: Date.now() + ms, text: text.slice(0, 500), channelId: ctx.message.channelId });
    save();
    await ctx.ok(`I will remind you ${fmtTime(Date.now() + ms)}.`);
  },
  "reminder clear": async (ctx) => {
    userData(ctx.member.id).reminders = [];
    save();
    await ctx.ok("Removed all your reminders.");
  },

  me: (ctx) => showStats(ctx, ctx.member.id, "Your activity"),
  user: async (ctx) => {
    const id = ctx.args[0]?.replace(/\D/g, "") || ctx.member.id;
    await showStats(ctx, id, "Activity");
  },
  "info user": async (ctx) => {
    const id = ctx.args[0]?.replace(/\D/g, "") || ctx.member.id;
    await showStats(ctx, id, "Activity");
  },
  info: async (ctx) => {
    const rows = Object.entries(activity(ctx.guild.id));
    const total = rows.reduce((n, [, r]) => n + r.m, 0);
    const voice = rows.reduce((n, [, r]) => n + r.v, 0);
    const top = rows
      .sort((a, b) => b[1].m - a[1].m)
      .slice(0, 5)
      .map(([id, r], i) => `**${i + 1}.** <@${id}> - ${r.m.toLocaleString("en-US")}`);
    await ctx.reply(embed(`**Messages:** ${total.toLocaleString("en-US")}\n**Voice time:** ${formatDuration(voice)}\n\n**Top chatters**\n${top.join("\n") || "None yet."}`, "Server activity"));
  },
};

function renderTemplate(t: string, m: Message<true>): string {
  return t
    .replaceAll("{user.mention}", `<@${m.author.id}>`)
    .replaceAll("{user}", m.author.username)
    .replaceAll("{server}", m.guild.name);
}

async function onMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.inGuild()) return;
  const g = message.guild.id;
  const content = message.content.toLowerCase();

  const row = (activity(g)[message.author.id] ??= { m: 0, v: 0 });
  row.m += 1;
  save();

  const away = userData(message.author.id).afk as { reason: string; since: number } | undefined;
  if (away && !content.startsWith(";afk")) {
    delete userData(message.author.id).afk;
    save();
    const note = await message.reply({ content: `Welcome back. You were AFK for ${formatDuration(Date.now() - away.since)}.`, allowedMentions: { repliedUser: false } });
    setTimeout(() => void note.delete().catch(() => undefined), 6000);
  }
  for (const user of message.mentions.users.values()) {
    const afk = userData(user.id).afk as { reason: string; since: number } | undefined;
    if (afk && user.id !== message.author.id) {
      await message.reply({ content: `**${user.username}** is AFK: ${afk.reason} (${fmtTime(afk.since)})`, allowedMentions: { parse: [] } });
    }
  }

  const matches = (t: string) => new RegExp(`(^|\\W)${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\W)`, "i").test(content);
  for (const [t, response] of Object.entries(responders(g))) {
    if (matches(t)) {
      await message.channel.send({ content: renderTemplate(response, message), allowedMentions: { parse: [] } });
      break;
    }
  }
  for (const [t, emojis] of Object.entries(reacts(g))) {
    if (matches(t)) for (const e of emojis) await message.react(e).catch(() => undefined);
  }
}

export function startAutomation(client: Client): void {
  client.on("messageCreate", (m) => {
    void onMessage(m).catch((err: unknown) => logger.error({ err }, "Automation failed"));
  });

  client.on("guildMemberAdd", (member) => {
    void (async () => {
      const lists = ((guildData(member.guild.id).settings?.lists ?? {}) as Record<string, string[]>);
      const ids = [...(lists["autorole all"] ?? []), ...(member.user.bot ? lists["autorole bots"] ?? [] : lists["autorole humans"] ?? [])];
      for (const id of ids) await member.roles.add(id, "Autorole").catch(() => undefined);
    })().catch((err: unknown) => logger.error({ err }, "Autorole failed"));
  });

  const joined = new Map<string, number>();
  client.on("voiceStateUpdate", (before, after) => {
    const key = `${after.guild.id}:${after.id}`;
    if (!before.channelId && after.channelId) joined.set(key, Date.now());
    if (before.channelId && !after.channelId) {
      const start = joined.get(key);
      joined.delete(key);
      if (start) {
        (activity(after.guild.id)[after.id] ??= { m: 0, v: 0 }).v += Date.now() - start;
        save();
      }
    }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [userId, bag] of Object.entries(allUsers())) {
      const list = (bag.reminders ?? []) as { at: number; text: string; channelId: string }[];
      const due = list.filter((r) => r.at <= now);
      if (!due.length) continue;
      bag.reminders = list.filter((r) => r.at > now);
      save();
      for (const r of due) {
        const channel = client.channels.cache.get(r.channelId);
        if (channel?.isTextBased() && "send" in channel) {
          void channel.send({ content: `<@${userId}> Reminder: ${r.text}`, allowedMentions: { users: [userId] } }).catch(() => undefined);
        }
      }
    }
  }, 15_000).unref();
}
