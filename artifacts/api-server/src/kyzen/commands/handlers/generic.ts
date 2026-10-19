import { guildData, save } from "../../store";
import { parseChannel, parseMember, parseRole } from "../args";
import { CommandError, type Ctx, type Handler, type Indexed } from "../types";
import { embed } from "../ui";

/** Modules whose commands are server settings. */
const SETTINGS_MODULES = new Set([
  "config",
  "security",
  "confessions",
  "feeds",
  "reposter",
  "track",
  "voicemaster",
  "statistics",
  "socials",
  "esports",
  "minecraft",
]);

const ENABLE = new Set(["enable", "on"]);
const DISABLE = new Set(["disable", "off"]);
const SHOW = new Set(["view", "list", "settings", "config", "show"]);
const WIPE = new Set(["clear", "reset"]);
const ADD = new Set(["add"]);
const REMOVE = new Set(["remove"]);

interface SettingsBag {
  values: Record<string, string>;
  lists: Record<string, string[]>;
  flags: Record<string, boolean>;
}

function settings(guildId: string): SettingsBag {
  const bag = guildData(guildId);
  bag.settings ??= { values: {}, lists: {}, flags: {} } satisfies SettingsBag;
  return bag.settings as SettingsBag;
}

const parentOf = (path: string) => path.split(" ").slice(0, -1).join(" ");
const under = (key: string, prefix: string) => key === prefix || key.startsWith(`${prefix} `);

/** Turns mentions/names into stored ids according to the parameter's name. */
async function normalise(ctx: Ctx, name: string, token: string): Promise<string> {
  const n = name.toLowerCase();
  if (n.includes("channel")) return parseChannel(ctx, token)?.id ?? token;
  if (n.includes("role")) return parseRole(ctx, token)?.id ?? token;
  if (n.includes("member") || n.includes("user")) {
    return (await parseMember(ctx, token))?.id ?? token.replace(/\D/g, "") ?? token;
  }
  return token;
}

function display(value: string): string {
  return /^\d{15,22}$/.test(value) ? `\`${value}\`` : value;
}

export function genericHandlerFor(indexed: Indexed): Handler | undefined {
  if (!SETTINGS_MODULES.has(indexed.moduleId)) return undefined;
  const { entry } = indexed;
  const parts = entry.path.toLowerCase().split(" ");
  const verb = parts[parts.length - 1];
  const parent = parentOf(entry.path.toLowerCase());
  const isVerb = [ENABLE, DISABLE, SHOW, WIPE, ADD, REMOVE].some((s) => s.has(verb));
  const subject = parent || undefined;

  if (subject && ENABLE.has(verb)) {
    return async (ctx) => {
      settings(ctx.guild.id).flags[subject] = true;
      save();
      await ctx.ok(`Enabled **${subject}**.`);
    };
  }
  if (subject && DISABLE.has(verb)) {
    return async (ctx) => {
      settings(ctx.guild.id).flags[subject] = false;
      save();
      await ctx.ok(`Disabled **${subject}**.`);
    };
  }
  if (subject && WIPE.has(verb) && !indexed.hasChildren) {
    return async (ctx) => {
      const s = settings(ctx.guild.id);
      for (const key of Object.keys(s.values)) if (under(key, subject)) delete s.values[key];
      for (const key of Object.keys(s.lists)) if (under(key, subject)) delete s.lists[key];
      for (const key of Object.keys(s.flags)) if (under(key, subject)) delete s.flags[key];
      save();
      await ctx.ok(`Cleared saved settings for **${subject}**.`);
    };
  }
  if (subject && SHOW.has(verb) && !indexed.hasChildren) {
    return async (ctx) => {
      const s = settings(ctx.guild.id);
      const lines: string[] = [];
      for (const [k, v] of Object.entries(s.flags)) if (under(k, subject)) lines.push(`**${k}:** ${v ? "Enabled" : "Disabled"}`);
      for (const [k, v] of Object.entries(s.values)) if (under(k, subject)) lines.push(`**${k}:** ${display(v)}`);
      for (const [k, v] of Object.entries(s.lists)) if (under(k, subject)) lines.push(`**${k}:** ${v.length ? v.map(display).join(", ") : "Empty"}`);
      await ctx.reply(embed(lines.join("\n") || "Nothing is saved here yet.", `Settings: ${subject}`));
    };
  }
  if (subject && ADD.has(verb) && entry.parameters.length > 0) {
    return async (ctx) => {
      const value = await normalise(ctx, entry.parameters[0].name, ctx.args[0]);
      const list = (settings(ctx.guild.id).lists[subject] ??= []);
      if (!list.includes(value)) list.push(value);
      save();
      await ctx.ok(`Added ${display(value)} to **${subject}**.`);
    };
  }
  if (subject && REMOVE.has(verb) && entry.parameters.length > 0) {
    return async (ctx) => {
      const value = await normalise(ctx, entry.parameters[0].name, ctx.args[0]);
      const s = settings(ctx.guild.id);
      const before = s.lists[subject]?.length ?? 0;
      s.lists[subject] = (s.lists[subject] ?? []).filter((x) => x !== value);
      if (s.lists[subject].length === before) throw new CommandError("That entry is not in the list.");
      save();
      await ctx.ok(`Removed ${display(value)} from **${subject}**.`);
    };
  }
  // A leaf that stores a value: "set (target)", "channel (channel)", "threshold (limit)" ...
  if (!isVerb && !indexed.hasChildren && entry.parameters.length > 0) {
    return async (ctx) => {
      const [first, ...rest] = entry.parameters;
      const stored = [await normalise(ctx, first.name, ctx.args[0]), ...ctx.args.slice(1)].join(" ");
      void rest;
      settings(ctx.guild.id).values[entry.path.toLowerCase()] = stored;
      save();
      await ctx.ok(`Saved **${entry.path}**: ${display(stored)}`);
    };
  }
  return undefined;
}
