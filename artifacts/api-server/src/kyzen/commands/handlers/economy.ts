import { allUsers, save, userData } from "../../store";
import { parseInteger, parseMember } from "../args";
import { CommandError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";

const CURRENCY = "Dallars";
export const fmt = (n: number) => `${n.toLocaleString("en-US")} ${CURRENCY}`;

interface Eco {
  wallet: number;
  bank: number;
  cooldowns: Record<string, number>;
}
export function eco(userId: string): Eco {
  const bag = userData(userId);
  bag.eco ??= { wallet: 0, bank: 0, cooldowns: {} } satisfies Eco;
  return bag.eco as Eco;
}

function cooldown(account: Eco, key: string, ms: number): number {
  const wait = (account.cooldowns[key] ?? 0) + ms - Date.now();
  if (wait > 0) return wait;
  account.cooldowns[key] = Date.now();
  return 0;
}
const left = (ms: number) => `<t:${Math.floor((Date.now() + ms) / 1000)}:R>`;
const between = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

function reward(key: string, ms: number, min: number, max: number, label: string): Handler {
  return async (ctx) => {
    const account = eco(ctx.member.id);
    const wait = cooldown(account, key, ms);
    if (wait) throw new CommandError(`You can claim your ${label} reward ${left(wait)}.`);
    const amount = between(min, max);
    account.wallet += amount;
    save();
    await ctx.ok(`You claimed your ${label} reward of **${fmt(amount)}**.`);
  };
}

export function amountOf(token: string | undefined, available: number): number {
  const n = token?.toLowerCase() === "all" ? available : parseInteger(token);
  if (n === null || n === undefined || n <= 0) throw new CommandError("Enter a valid amount, or `all`.");
  if (n > available) throw new CommandError(`You only have **${fmt(available)}** available.`);
  return n;
}

export const ECONOMY_HANDLERS: Record<string, Handler> = {
  balance: async (ctx) => {
    const target = ctx.args[0] ? await parseMember(ctx, ctx.args[0]) : ctx.member;
    if (!target) throw new CommandError("I could not find that member.");
    const a = eco(target.id);
    await ctx.reply(
      embed(
        `**Wallet:** ${fmt(a.wallet)}\n**Bank:** ${fmt(a.bank)}\n**Net worth:** ${fmt(a.wallet + a.bank)}`,
        `${target.displayName}'s balance`,
      ),
    );
  },
  daily: reward("daily", 86_400_000, 400, 700, "daily"),
  weekly: reward("weekly", 604_800_000, 2_500, 4_000, "weekly"),
  monthly: reward("monthly", 2_592_000_000, 10_000, 16_000, "monthly"),
  work: reward("work", 1_800_000, 120, 450, "work"),
  beg: async (ctx: Ctx) => {
    const account = eco(ctx.member.id);
    const wait = cooldown(account, "beg", 60_000);
    if (wait) throw new CommandError(`Try begging again ${left(wait)}.`);
    const amount = between(0, 60);
    account.wallet += amount;
    save();
    await ctx.ok(amount ? `Someone gave you **${fmt(amount)}**.` : "Nobody gave you anything.");
  },
  deposit: async (ctx) => {
    const a = eco(ctx.member.id);
    const n = amountOf(ctx.args[0], a.wallet);
    a.wallet -= n;
    a.bank += n;
    save();
    await ctx.ok(`Deposited **${fmt(n)}** into your bank.`);
  },
  withdraw: async (ctx) => {
    const a = eco(ctx.member.id);
    const n = amountOf(ctx.args[0], a.bank);
    a.bank -= n;
    a.wallet += n;
    save();
    await ctx.ok(`Withdrew **${fmt(n)}** from your bank.`);
  },
  pay: async (ctx) => {
    const target = await parseMember(ctx, ctx.args[0]);
    if (!target || target.user.bot || target.id === ctx.member.id) {
      throw new CommandError("Pick another member to pay.");
    }
    const from = eco(ctx.member.id);
    const n = amountOf(ctx.args[1], from.wallet);
    from.wallet -= n;
    eco(target.id).wallet += n;
    save();
    await ctx.ok(`Sent **${fmt(n)}** to ${target}.`);
  },
  leaderboard: async (ctx) => {
    const rows = Object.entries(allUsers())
      .map(([id, bag]) => [id, ((bag.eco as Eco | undefined)?.wallet ?? 0) + ((bag.eco as Eco | undefined)?.bank ?? 0)] as const)
      .filter(([, total]) => total > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 10)
      .map(([id, total], i) => `**${i + 1}.** <@${id}> - ${fmt(total)}`);
    await ctx.reply(embed(rows.join("\n") || "Nobody has any money yet.", "Richest users"));
  },
};
