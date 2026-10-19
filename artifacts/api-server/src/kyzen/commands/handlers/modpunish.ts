import { ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildMember, type Role, type TextChannel } from "discord.js";
import { logger } from "../../../lib/logger";
import { guildData, save } from "../../store";
import { formatDuration, parseChannel, parseDuration, parseMember, parseRole, parseUser } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";
import { assertCanAct } from "./moderation";
import { logCase } from "./modlog";
import { backupRoles } from "./modtools";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bag = Record<string, any>;
interface Timed { type: "unban" | "unjail"; userId: string; at: number }
const timed = (g: string): Timed[] => ((guildData(g).timed ??= []) as Timed[]);
const jailCfg = (g: string): Bag => (guildData(g).jail ??= { managers: [], jailed: {} });
const reasonFrom = (ctx: Ctx, from: number) => ctx.args.slice(from).join(" ") || "No reason provided";
const audit = (ctx: Ctx, r: string) => `${r} (by ${ctx.member.user.tag})`;

/* ---------- temp / hard bans ---------- */
async function banFlow(ctx: Ctx, type: "tempban" | "hardban"): Promise<void> {
  const user = await parseUser(ctx, ctx.args[0]);
  if (!user) throw new CommandError("I could not find that user.");
  const member = await ctx.guild.members.fetch(user.id).catch(() => null);
  if (member) {
    assertCanAct(ctx, member);
    if (!member.bannable) throw new CommandError("I cannot ban that member.");
  }
  const duration = parseDuration(ctx.args[1]);
  const ms = duration ?? (type === "tempban" ? 86_400_000 : undefined);
  const reason = reasonFrom(ctx, duration ? 2 : 1);
  await ctx.guild.members.ban(user.id, { reason: audit(ctx, reason), deleteMessageSeconds: type === "hardban" ? 7 * 86_400 : 0 });
  if (ms) { timed(ctx.guild.id).push({ type: "unban", userId: user.id, at: Date.now() + ms }); save(); }
  logCase(ctx, type, user.id, reason, ms);
  await ctx.ok(`${type === "hardban" ? "Hardbanned" : "Temporarily banned"} **${user.tag}**${ms ? ` for ${formatDuration(ms)}` : ""}.`);
}

/* ---------- jail ---------- */
async function setupJail(ctx: Ctx): Promise<void> {
  const cfg = jailCfg(ctx.guild.id);
  const role = await ctx.guild.roles.create({ name: "Jailed", permissions: [], reason: "Jail setup" });
  const channel = await ctx.guild.channels.create({
    name: "jail",
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: ctx.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ],
  });
  for (const ch of ctx.guild.channels.cache.values()) {
    if (ch.id === channel.id || !("permissionOverwrites" in ch) || ch.isThread()) continue;
    await ch.permissionOverwrites.edit(role.id, { ViewChannel: false, SendMessages: false, Connect: false }).catch(() => undefined);
  }
  cfg.roleId = role.id;
  cfg.channelId = channel.id;
  save();
  await ctx.ok(`Created ${role} and ${channel}. Jailed members can only see that channel.`);
}

async function jailMember(ctx: Ctx, member: GuildMember, reason: string): Promise<void> {
  const cfg = jailCfg(ctx.guild.id);
  const role = cfg.roleId && ctx.guild.roles.cache.get(cfg.roleId);
  if (!role) throw new CommandError(`Run \`${ctx.prefix}jail setup\` first.`);
  backupRoles(member);
  cfg.jailed[member.id] = ((guildData(ctx.guild.id).roleBackup ?? {}) as Record<string, string[]>)[member.id] ?? [];
  const removable = member.roles.cache.filter((r) => r.id !== ctx.guild.id && !r.managed && r.editable);
  await member.roles.remove(removable, audit(ctx, reason)).catch(() => undefined);
  await member.roles.add(role, audit(ctx, reason));
  if (member.voice.channel) await member.voice.disconnect("Jailed").catch(() => undefined);
  save();
  const ch = cfg.channelId && ctx.guild.channels.cache.get(cfg.channelId);
  if (ch?.isTextBased() && "send" in ch) await ch.send({ content: `${member} ${cfg.message ?? "You have been jailed. Wait for a moderator."}`, allowedMentions: { users: [member.id] } }).catch(() => undefined);
}

async function unjailMember(guild: Guild, userId: string): Promise<boolean> {
  const cfg = jailCfg(guild.id);
  const member = await guild.members.fetch(userId).catch(() => null);
  const roles = (cfg.jailed[userId] ?? []) as string[];
  delete cfg.jailed[userId];
  save();
  if (!member) return false;
  if (cfg.roleId) await member.roles.remove(cfg.roleId, "Unjailed").catch(() => undefined);
  const restorable = roles.filter((id) => guild.roles.cache.get(id)?.editable);
  await member.roles.add(restorable, "Unjailed").catch(() => undefined);
  return true;
}

/* ---------- chatban / vcban ---------- */
function banRoleHandlers(root: "chatban" | "vcban", roleName: string, label: string): Record<string, Handler> {
  const cfg = (g: string): Bag => (guildData(g)[root] ??= { managers: [], members: [] });
  const targetOf = async (ctx: Ctx): Promise<GuildMember> => {
    const m = await parseMember(ctx, ctx.args[0]);
    if (!m) throw new CommandError("I could not find that member.");
    return m;
  };
  const needRole = (ctx: Ctx) => {
    const id: string | undefined = cfg(ctx.guild.id).roleId;
    const role: Role | undefined = id ? ctx.guild.roles.cache.get(id) : undefined;
    if (!role) throw new CommandError(`Run \`${ctx.prefix}${root} setup\` first.`);
    return role;
  };
  const managerTarget = async (ctx: Ctx) => (await parseMember(ctx, ctx.args[0]))?.id ?? parseRole(ctx, ctx.args[0])?.id;
  return {
    [`${root} setup`]: async (ctx) => {
      const c = cfg(ctx.guild.id);
      const role = (c.roleId && ctx.guild.roles.cache.get(c.roleId)) || (await ctx.guild.roles.create({ name: roleName, permissions: [], reason: `${label} setup` }));
      let n = 0;
      for (const ch of ctx.guild.channels.cache.values()) {
        if (ch.isThread() || !("permissionOverwrites" in ch)) continue;
        const text = ch.isTextBased() && !ch.isVoiceBased();
        if (root === "chatban" ? !ch.isTextBased() : !ch.isVoiceBased()) continue;
        void text;
        await ch.permissionOverwrites.edit(role.id, root === "chatban" ? { SendMessages: false, AddReactions: false, SendMessagesInThreads: false, CreatePublicThreads: false } : { Connect: false }).then(() => { n += 1; }).catch(() => undefined);
      }
      c.roleId = role.id;
      save();
      await ctx.ok(`Set up ${role} and applied it to **${n}** channels. Run setup again after creating new channels.`);
    },
    [`${root} add`]: async (ctx) => {
      const m = await targetOf(ctx);
      assertCanAct(ctx, m);
      await m.roles.add(needRole(ctx), audit(ctx, label));
      if (root === "vcban" && m.voice.channel) await m.voice.disconnect(label).catch(() => undefined);
      logCase(ctx, root, m.id, "");
      await ctx.ok(`${m} is now ${label.toLowerCase()}ed.`.replace("ed.ed", "ed"));
    },
    [`${root} remove`]: async (ctx) => { const m = await targetOf(ctx); await m.roles.remove(needRole(ctx), audit(ctx, `Un${root}`)); await ctx.ok(`Removed the ${root} from ${m}.`); },
    [`${root} list`]: async (ctx) => {
      const role = needRole(ctx);
      await ctx.guild.members.fetch();
      await ctx.reply(embed(role.members.map((m) => `${m}`).join("\n") || "Nobody.", `${label} list`));
    },
    [`${root} config`]: async (ctx) => {
      const c = cfg(ctx.guild.id);
      await ctx.reply(embed(`**Role:** ${c.roleId ? `<@&${c.roleId}>` : "Not set up"}\n**Managers:** ${c.managers.map((x: string) => `<@${x}> <@&${x}>`).join(", ") || "None"}`, `${label} config`));
    },
    [`${root} managers add`]: async (ctx) => { const id = await managerTarget(ctx); if (!id) throw new CommandError("I could not find that member or role."); const c = cfg(ctx.guild.id); if (!c.managers.includes(id)) c.managers.push(id); save(); await ctx.ok("Added the manager."); },
    [`${root} managers remove`]: async (ctx) => { const id = await managerTarget(ctx); const c = cfg(ctx.guild.id); c.managers = c.managers.filter((x: string) => x !== id); save(); await ctx.ok("Removed the manager."); },
  };
}

/* ---------- autopurge ---------- */
const autopurge = (g: string): Record<string, number> => ((guildData(g).autopurge ??= {}) as never);

export const MODPUNISH_HANDLERS: Record<string, Handler> = {
  tempban: (ctx) => banFlow(ctx, "tempban"),
  hardban: (ctx) => banFlow(ctx, "hardban"),

  "jail setup": setupJail,
  "jail role": async (ctx) => { const r = parseRole(ctx, ctx.raw); if (!r) throw new CommandError("I could not find that role."); jailCfg(ctx.guild.id).roleId = r.id; save(); await ctx.ok(`${r} is now the jail role.`); },
  "jail channel": async (ctx) => { const ch = parseChannel(ctx, ctx.args[0]); if (!ch?.isTextBased()) throw new CommandError("I could not find that text channel."); jailCfg(ctx.guild.id).channelId = ch.id; save(); await ctx.ok(`Jailed members will be greeted in ${ch}.`); },
  "jail message": async (ctx) => { jailCfg(ctx.guild.id).message = ctx.raw.slice(0, 500); save(); await ctx.ok("Updated the jail message."); },
  "jail config": async (ctx) => { const c = jailCfg(ctx.guild.id); await ctx.reply(embed(`**Role:** ${c.roleId ? `<@&${c.roleId}>` : "Not set"}\n**Channel:** ${c.channelId ? `<#${c.channelId}>` : "Not set"}\n**Message:** ${c.message ?? "Default"}\n**Jailed:** ${Object.keys(c.jailed).length}`, "Jail config")); },
  "jail list": async (ctx) => { await ctx.reply(embed(Object.keys(jailCfg(ctx.guild.id).jailed).map((id) => `<@${id}>`).join("\n") || "Nobody is jailed.", "Jailed members")); },
  "jail reset": async (ctx) => {
    const c = jailCfg(ctx.guild.id);
    if (c.roleId) await ctx.guild.roles.cache.get(c.roleId)?.delete("Jail reset").catch(() => undefined);
    if (c.channelId) await ctx.guild.channels.cache.get(c.channelId)?.delete("Jail reset").catch(() => undefined);
    guildData(ctx.guild.id).jail = { managers: [], jailed: {} };
    save();
    await ctx.ok("Deleted the jail role and channel.");
  },
  "jail manager add": async (ctx) => { const id = (await parseMember(ctx, ctx.args[0]))?.id ?? parseRole(ctx, ctx.args[0])?.id; if (!id) throw new CommandError("I could not find that member or role."); const c = jailCfg(ctx.guild.id); if (!c.managers.includes(id)) c.managers.push(id); save(); await ctx.ok("Added the jail manager."); },
  "jail manager remove": async (ctx) => { const id = (await parseMember(ctx, ctx.args[0]))?.id ?? parseRole(ctx, ctx.args[0])?.id; const c = jailCfg(ctx.guild.id); c.managers = c.managers.filter((x: string) => x !== id); save(); await ctx.ok("Removed the jail manager."); },
  "jail manager list": async (ctx) => { await ctx.reply(embed(jailCfg(ctx.guild.id).managers.map((x: string) => `<@${x}> <@&${x}>`).join("\n") || "None.", "Jail managers")); },
  jail: async (ctx) => {
    const member = await parseMember(ctx, ctx.args[0]);
    if (!member) throw new CommandError("I could not find that member.");
    assertCanAct(ctx, member);
    const duration = parseDuration(ctx.args[1]);
    const reason = reasonFrom(ctx, duration ? 2 : 1);
    await jailMember(ctx, member, reason);
    if (duration) { timed(ctx.guild.id).push({ type: "unjail", userId: member.id, at: Date.now() + duration }); save(); }
    logCase(ctx, "jail", member.id, reason, duration ?? undefined);
    await ctx.ok(`Jailed ${member}${duration ? ` for ${formatDuration(duration)}` : ""}.`);
  },
  unjail: async (ctx) => {
    const user = await parseUser(ctx, ctx.args[0]);
    if (!user || !jailCfg(ctx.guild.id).jailed[user.id]) throw new CommandError("That member is not jailed.");
    await unjailMember(ctx.guild, user.id);
    logCase(ctx, "unjail", user.id, reasonFrom(ctx, 1));
    await ctx.ok(`Unjailed ${user}.`);
  },

  ...banRoleHandlers("chatban", "Chatbanned", "Chat ban"),
  ...banRoleHandlers("vcban", "VC Banned", "VC ban"),

  "autopurge set": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    const ms = parseDuration(ctx.args[1]);
    if (!ch?.isTextBased() || !ms || ms < 60_000 || ms > 13 * 86_400_000) throw new CommandError("Use `autopurge set (channel) (duration)` with a duration between 1m and 13d.");
    autopurge(ctx.guild.id)[ch.id] = ms;
    save();
    await ctx.ok(`Messages in ${ch} will be deleted after **${formatDuration(ms)}**.`);
  },
  "autopurge remove": async (ctx) => { const ch = parseChannel(ctx, ctx.args[0]); if (!ch || !(ch.id in autopurge(ctx.guild.id))) throw new CommandError("That channel is not auto-purged."); delete autopurge(ctx.guild.id)[ch.id]; save(); await ctx.ok(`Stopped auto-purging ${ch}.`); },
  "autopurge list": async (ctx) => { await ctx.reply(embed(Object.entries(autopurge(ctx.guild.id)).map(([id, ms]) => `<#${id}> - ${formatDuration(ms)}`).join("\n") || "No auto-purged channels.", "Autopurge")); },
};

export function startPunishments(client: Client): void {
  client.on("guildMemberAdd", (m) => {
    const c = jailCfg(m.guild.id);
    if (c.jailed[m.id] && c.roleId) void m.roles.add(c.roleId, "Still jailed").catch(() => undefined);
  });
  setInterval(() => {
    void (async () => {
      for (const guild of client.guilds.cache.values()) {
        const list = timed(guild.id);
        const due = list.filter((t) => t.at <= Date.now());
        if (due.length) {
          guildData(guild.id).timed = list.filter((t) => t.at > Date.now());
          save();
          for (const t of due) {
            if (t.type === "unban") await guild.members.unban(t.userId, "Temporary ban expired").catch(() => undefined);
            else await unjailMember(guild, t.userId);
          }
        }
        for (const [channelId, ms] of Object.entries(autopurge(guild.id))) {
          const ch = guild.channels.cache.get(channelId) as TextChannel | undefined;
          if (!ch?.isTextBased()) continue;
          const old = [...(await ch.messages.fetch({ limit: 100 }).catch(() => null))?.values() ?? []].filter((m) => !m.pinned && Date.now() - m.createdTimestamp > ms && Date.now() - m.createdTimestamp < 13.5 * 86_400_000);
          if (old.length) await ch.bulkDelete(old, true).catch(() => undefined);
        }
      }
    })().catch((err: unknown) => logger.error({ err }, "Moderation timers failed"));
  }, 30_000).unref();
}

export { UsageError };
