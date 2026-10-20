import { globalData, guildData, save, userData } from "../../store";
import { guildPrefix } from "../../prefix";
import { isPremiumGuild } from "../../owner";
import { CommandError, type Handler } from "../types";
import { embed } from "../ui";

const MAX = 5;
function valid(p: string): string {
  if (p.length < 1 || p.length > MAX || /\s/.test(p) || /[`\\]/.test(p)) {
    throw new CommandError(`A prefix must be 1 to ${MAX} characters with no spaces.`);
  }
  return p;
}

export const PREFIX_HANDLERS: Record<string, Handler> = {
  prefix: async (ctx) => {
    const mine = userData(ctx.member.id).prefix as string | undefined;
    await ctx.reply(embed(`**Server prefix:** \`${guildPrefix(ctx.guild.id)}\`\n**Your prefix:** ${mine ? `\`${mine}\`` : "Not set"}`, "Prefix"));
  },
  "prefix set": async (ctx) => {
    const p = valid(ctx.args[0]);
    guildData(ctx.guild.id).prefix = p;
    save();
    await ctx.ok(`The server prefix is now \`${p}\`.`);
  },
  "prefix self": async (ctx) => {
    if (!ctx.args[0]) {
      const mine = userData(ctx.member.id).prefix as string | undefined;
      await ctx.ok(mine ? `Your personal prefix is \`${mine}\`.` : "You have no personal prefix.");
      return;
    }
    userData(ctx.member.id).prefix = valid(ctx.args[0]);
    save();
    await ctx.ok(`Your personal prefix is now \`${ctx.args[0]}\`. It works in every server.`);
  },
  "prefix self set": async (ctx) => {
    userData(ctx.member.id).prefix = valid(ctx.args[0]);
    save();
    await ctx.ok(`Your personal prefix is now \`${ctx.args[0]}\`. It works in every server.`);
  },
  "prefix self reset": async (ctx) => {
    delete userData(ctx.member.id).prefix;
    save();
    await ctx.ok("Removed your personal prefix.");
  },
  "prefix noprefix": async (ctx) => {
    if (!isPremiumGuild(ctx.guild.id)) throw new CommandError("Server-wide no-prefix mode is a **Premium** perk. Ask the staff to activate premium here.");
    const on = ["on", "true", "yes", "enable"].includes(ctx.args[0].toLowerCase());
    const g = globalData();
    const list = ((g.guildNP ??= []) as string[]).filter((id) => id !== ctx.guild.id);
    g.guildNP = on ? [...list, ctx.guild.id] : list;
    save();
    await ctx.ok(`Server-wide no-prefix mode is now **${on ? "on" : "off"}**.`);
  },
};
