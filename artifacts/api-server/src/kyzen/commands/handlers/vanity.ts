import { type Client, type Presence } from "discord.js";
import { guildData, save } from "../../store";
import { logger } from "../../../lib/logger";
import { parseChannel, parseMember, parseRole, mentionOf } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Notice {
  enabled: boolean;
  text?: string;
  channel?: string;
}
export interface VanityConfig {
  enabled: boolean;
  target?: string;
  strict: boolean;
  channel?: string;
  message: Notice;
  revoke: Notice;
  rewards: string[];
  ignoreUsers: string[];
  ignoreRoles: string[];
  active: string[];
}

const DEFAULT_MESSAGE = "Thanks {user.mention} for repping {target}!";
const DEFAULT_REVOKE = "{user.mention} stopped repping {target}.";

function cfg(guildId: string): VanityConfig {
  const bag = guildData(guildId);
  bag.vanity ??= {
    enabled: false,
    strict: false,
    message: { enabled: true },
    revoke: { enabled: true },
    rewards: [],
    ignoreUsers: [],
    ignoreRoles: [],
    active: [],
  } satisfies VanityConfig;
  return bag.vanity as VanityConfig;
}

const yesNo = (v: boolean) => (v ? "Enabled" : "Disabled");
const list = (items: string[], kind: "user" | "role") =>
  items.length ? items.map((id) => mentionOf(kind, id)).join(", ") : "None";

function noticeHandlers(key: "message" | "revoke", label: string): Record<string, Handler> {
  const get = (ctx: Ctx) => cfg(ctx.guild.id)[key];
  const fallback = key === "message" ? DEFAULT_MESSAGE : DEFAULT_REVOKE;
  return {
    [key]: async (ctx) => {
      const n = get(ctx);
      if (ctx.args.length === 0) {
        await ctx.ok(`Current ${label} message:\n${n.text ?? fallback}`);
        return;
      }
      n.text = ctx.raw.slice(0, 1000);
      save();
      await ctx.ok(`Set the ${label} message.`);
    },
    [`${key} channel`]: async (ctx) => {
      const ch = parseChannel(ctx, ctx.args[0]);
      if (!ch?.isTextBased()) throw new CommandError("I could not find that text channel.");
      get(ctx).channel = ch.id;
      save();
      await ctx.ok(`The ${label} message will be sent in ${ch}.`);
    },
    [`${key} clear`]: async (ctx) => {
      get(ctx).text = undefined;
      save();
      await ctx.ok(`Cleared the custom ${label} message. The default will be used.`);
    },
    [`${key} disable`]: async (ctx) => {
      get(ctx).enabled = false;
      save();
      await ctx.ok(`The ${label} message is now disabled.`);
    },
    [`${key} enable`]: async (ctx) => {
      get(ctx).enabled = true;
      save();
      await ctx.ok(`The ${label} message is now enabled.`);
    },
    [`${key} view`]: async (ctx) => {
      const n = get(ctx);
      await ctx.ok(
        `**${yesNo(n.enabled)}**\n${n.text ?? fallback}\nChannel: ${n.channel ? `<#${n.channel}>` : "Default"}`,
      );
    },
  };
}

function toggleList(
  field: "ignoreUsers" | "ignoreRoles" | "rewards",
  kind: "user" | "role",
): { add: Handler; remove: Handler; clear: Handler; view: Handler } {
  const resolve = async (ctx: Ctx): Promise<string> => {
    const target =
      kind === "user"
        ? (await parseMember(ctx, ctx.args[0]))?.id
        : parseRole(ctx, ctx.args[0])?.id;
    if (!target) throw new CommandError(`I could not find that ${kind === "user" ? "member" : "role"}.`);
    return target;
  };
  const noun = kind === "user" ? "member" : "role";
  return {
    add: async (ctx) => {
      const id = await resolve(ctx);
      const c = cfg(ctx.guild.id);
      if (!c[field].includes(id)) c[field].push(id);
      save();
      await ctx.ok(`Added ${mentionOf(kind, id)}.`);
    },
    remove: async (ctx) => {
      const id = await resolve(ctx);
      const c = cfg(ctx.guild.id);
      c[field] = c[field].filter((x) => x !== id);
      save();
      await ctx.ok(`Removed ${mentionOf(kind, id)}.`);
    },
    clear: async (ctx) => {
      cfg(ctx.guild.id)[field] = [];
      save();
      await ctx.ok(`Cleared all ${noun}s from this list.`);
    },
    view: async (ctx) => {
      await ctx.ok(list(cfg(ctx.guild.id)[field], kind));
    },
  };
}

const rewards = toggleList("rewards", "role");
const ignoreUsers = toggleList("ignoreUsers", "user");
const ignoreRoles = toggleList("ignoreRoles", "role");

export const VANITY_HANDLERS: Record<string, Handler> = {
  "vanity set": async (ctx) => {
    const target = ctx.raw.trim().toLowerCase();
    if (!target) throw new UsageError();
    const c = cfg(ctx.guild.id);
    c.target = target;
    save();
    await ctx.ok(`Vanity target set to \`${target}\`.`);
  },
  "vanity enable": async (ctx) => {
    const c = cfg(ctx.guild.id);
    if (!c.target) throw new CommandError(`Set a target first with \`${ctx.prefix}vanity set (target)\`.`);
    c.enabled = true;
    save();
    await ctx.ok("Vanity rewards are now enabled.");
  },
  "vanity disable": async (ctx) => {
    cfg(ctx.guild.id).enabled = false;
    save();
    await ctx.ok("Vanity rewards are now disabled.");
  },
  "vanity strict": async (ctx) => {
    const c = cfg(ctx.guild.id);
    c.strict = !c.strict;
    save();
    await ctx.ok(
      c.strict
        ? "Strict mode on. The status must be exactly the vanity target."
        : "Strict mode off. The target can appear anywhere in the status.",
    );
  },
  "vanity channel": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    if (!ch?.isTextBased()) throw new CommandError("I could not find that text channel.");
    cfg(ctx.guild.id).channel = ch.id;
    save();
    await ctx.ok(`Vanity addition and revoke messages will be sent in ${ch}.`);
  },
  "vanity reset": async (ctx) => {
    delete guildData(ctx.guild.id).vanity;
    save();
    await ctx.ok("Reset all vanity reward settings.");
  },
  "vanity settings": async (ctx) => {
    const c = cfg(ctx.guild.id);
    await ctx.reply(
      embed(
        [
          `**Status:** ${yesNo(c.enabled)}`,
          `**Target:** ${c.target ? `\`${c.target}\`` : "Not set"}`,
          `**Strict:** ${yesNo(c.strict)}`,
          `**Channel:** ${c.channel ? `<#${c.channel}>` : "Not set"}`,
          `**Rewards:** ${list(c.rewards, "role")}`,
          `**Ignored members:** ${list(c.ignoreUsers, "user")}`,
          `**Ignored roles:** ${list(c.ignoreRoles, "role")}`,
          `**Message:** ${yesNo(c.message.enabled)}`,
          `**Revoke message:** ${yesNo(c.revoke.enabled)}`,
        ].join("\n"),
        "Vanity settings",
      ),
    );
  },
  ...Object.fromEntries(
    Object.entries({
      ...noticeHandlers("message", "vanity"),
      ...noticeHandlers("revoke", "revoke"),
    }).map(([k, v]) => [`vanity ${k}`, v]),
  ),
  "vanity reward add": rewards.add,
  "vanity reward remove": rewards.remove,
  "vanity reward clear": rewards.clear,
  "vanity reward view": rewards.view,
  "vanity ignore user": ignoreUsers.add,
  "vanity ignore user remove": ignoreUsers.remove,
  "vanity ignore user clear": ignoreUsers.clear,
  "vanity ignore user view": ignoreUsers.view,
  "vanity ignore role": ignoreRoles.add,
  "vanity ignore role remove": ignoreRoles.remove,
  "vanity ignore role clear": ignoreRoles.clear,
  "vanity ignore role view": ignoreRoles.view,
};

function render(template: string, userId: string, target: string, guildName: string): string {
  return template
    .replaceAll("{user.mention}", `<@${userId}>`)
    .replaceAll("{user}", `<@${userId}>`)
    .replaceAll("{target}", target)
    .replaceAll("{guild}", guildName);
}

/** Gives or removes the reward roles when a member's custom status changes. */
export function startVanityWatcher(client: Client): void {
  client.on("presenceUpdate", (_old, presence: Presence) => {
    void handlePresence(presence).catch((err: unknown) =>
      logger.error({ err }, "Vanity presence handling failed"),
    );
  });
}

async function handlePresence(presence: Presence): Promise<void> {
  const guild = presence.guild;
  if (!guild || presence.user?.bot) return;
  const c = guildData(guild.id).vanity as VanityConfig | undefined;
  if (!c?.enabled || !c.target) return;

  const status =
    presence.activities.find((a) => a.type === 4)?.state?.trim().toLowerCase() ?? "";
  const has = c.strict ? status === c.target : status.includes(c.target);
  const userId = presence.userId;
  const wasActive = c.active.includes(userId);
  if (has === wasActive) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  if (
    c.ignoreUsers.includes(userId) ||
    member.roles.cache.some((r) => c.ignoreRoles.includes(r.id))
  ) {
    return;
  }

  if (has) {
    c.active.push(userId);
    for (const roleId of c.rewards) {
      await member.roles.add(roleId, "Vanity reward").catch(() => undefined);
    }
  } else {
    c.active = c.active.filter((id) => id !== userId);
    for (const roleId of c.rewards) {
      await member.roles.remove(roleId, "Vanity reward revoked").catch(() => undefined);
    }
  }
  save();

  const notice = has ? c.message : c.revoke;
  if (!notice.enabled) return;
  const channelId = notice.channel ?? c.channel;
  const channel = channelId ? guild.channels.cache.get(channelId) : undefined;
  if (!channel?.isTextBased()) return;
  const template = notice.text ?? (has ? DEFAULT_MESSAGE : DEFAULT_REVOKE);
  await channel
    .send({
      content: render(template, userId, c.target, guild.name),
      allowedMentions: { users: [userId] },
    })
    .catch(() => undefined);
}
