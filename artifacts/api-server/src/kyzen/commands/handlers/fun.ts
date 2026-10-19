import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { save } from "../../store";
import { parseInteger, parseUser } from "../args";
import { CommandError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";
import { amountOf, eco, fmt } from "./economy";

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

function bet(ctx: Ctx): number {
  const account = eco(ctx.member.id);
  return amountOf(ctx.args[0], account.wallet);
}

function settle(ctx: Ctx, stake: number, won: boolean, multiplier = 2): string {
  const account = eco(ctx.member.id);
  account.wallet += won ? Math.floor(stake * (multiplier - 1)) : -stake;
  save();
  return won
    ? `You won **${fmt(Math.floor(stake * (multiplier - 1)))}**. Wallet: ${fmt(account.wallet)}`
    : `You lost **${fmt(stake)}**. Wallet: ${fmt(account.wallet)}`;
}

const PROMPTS = [
  ["Be able to fly", "Be able to turn invisible"],
  ["Never use social media again", "Never watch a video again"],
  ["Always be 10 minutes late", "Always be 20 minutes early"],
  ["Live without music", "Live without movies"],
  ["Have unlimited money", "Have unlimited time"],
  ["Speak every language", "Talk to animals"],
  ["Live in the past", "Live in the future"],
  ["Only eat sweet food", "Only eat savory food"],
];

export const FUN_HANDLERS: Record<string, Handler> = {
  choose: async (ctx) => {
    const separator = ctx.raw.includes(",") ? "," : ctx.raw.includes("|") ? "|" : /\s+/;
    const options = ctx.raw.split(separator).map((s) => s.trim()).filter(Boolean);
    if (options.length < 2) throw new CommandError("Give me at least two choices, separated by commas.");
    await ctx.reply(embed(`I choose **${pick(options)}**.`));
  },
  randomhex: async (ctx) => {
    const n = Math.floor(Math.random() * 0xffffff);
    const hex = n.toString(16).padStart(6, "0").toUpperCase();
    await ctx.reply(embed(`**#${hex}**`).setColor(n));
  },
  spin: async (ctx) => {
    const target = ctx.args[0] ? await parseUser(ctx, ctx.args[0]) : null;
    await ctx.reply(embed(`**${ctx.member.displayName}** spins ${target ? `**${target.displayName}**` : "around"} for **${1 + Math.floor(Math.random() * 20)}** rotations.`));
  },
  wouldyourather: async (ctx) => {
    const [a, b] = pick(PROMPTS);
    await ctx.reply(embed(`**A:** ${a}\n**B:** ${b}`, "Would you rather"));
  },
  coinflip: async (ctx) => {
    const stake = bet(ctx);
    const side = ctx.args[1]?.toLowerCase();
    const guess = side === "heads" || side === "tails" ? side : pick(["heads", "tails"]);
    const result = pick(["heads", "tails"]);
    await ctx.reply(embed(`The coin landed on **${result}** (you picked ${guess}).\n${settle(ctx, stake, guess === result)}`));
  },
  dice: async (ctx) => {
    const stake = bet(ctx);
    const direction = ctx.args[1]?.toLowerCase() === "under" ? "under" : "over";
    const target = parseInteger(ctx.args[2]) ?? 50;
    if (target < 2 || target > 98) throw new CommandError("The target must be between 2 and 98.");
    const roll = 1 + Math.floor(Math.random() * 100);
    const chance = (direction === "over" ? 100 - target : target - 1) / 100;
    const won = direction === "over" ? roll > target : roll < target;
    await ctx.reply(embed(`You rolled **${roll}** (needed ${direction} ${target}).\n${settle(ctx, stake, won, 0.97 / chance)}`));
  },
  rps: async (ctx) => {
    const stake = bet(ctx);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ["rock", "paper", "scissors"].map((id) => new ButtonBuilder().setCustomId(`rps:${id}`).setLabel(id[0].toUpperCase() + id.slice(1)).setStyle(ButtonStyle.Secondary)),
    );
    const prompt = await ctx.message.reply({ content: "Pick one.", components: [row], allowedMentions: { repliedUser: false } });
    const click = await prompt
      .awaitMessageComponent({ filter: (i) => i.user.id === ctx.member.id, time: 30_000 })
      .catch(() => null);
    if (!click) {
      await prompt.edit({ content: "Timed out. No bet was taken.", components: [] }).catch(() => undefined);
      return;
    }
    const mine = click.customId.slice(4);
    const bot = pick(["rock", "paper", "scissors"]);
    const beats: Record<string, string> = { rock: "scissors", paper: "rock", scissors: "paper" };
    const tie = mine === bot;
    const won = beats[mine] === bot;
    const outcome = tie ? "It is a tie. Your bet was returned." : settle(ctx, stake, won);
    await click.update({ content: `You chose **${mine}**, I chose **${bot}**.\n${outcome}`, components: [] });
  },
};
