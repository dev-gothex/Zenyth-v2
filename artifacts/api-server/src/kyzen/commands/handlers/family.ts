import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type User } from "discord.js";
import { save, userData } from "../../store";
import { parseUser } from "../args";
import { CommandError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";

interface Family {
  partners: string[];
  parent?: string;
  children: string[];
}
function fam(id: string): Family {
  const bag = userData(id);
  bag.family ??= { partners: [], children: [] } satisfies Family;
  return bag.family as Family;
}
const link = (id: string) => `<@${id}>`;

async function targetOf(ctx: Ctx, required: boolean): Promise<User> {
  if (!ctx.args[0] && !required) return ctx.member.user;
  const user = await parseUser(ctx, ctx.args[0]);
  if (!user) throw new CommandError("I could not find that user.");
  return user;
}

/** Asks `target` to accept; resolves true only if they press Accept. */
async function ask(ctx: Ctx, target: User, text: string): Promise<boolean> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("fam:yes").setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("fam:no").setLabel("Decline").setStyle(ButtonStyle.Danger),
  );
  const prompt = await ctx.message.reply({
    content: `${target}, ${text}`,
    components: [row],
    allowedMentions: { users: [target.id], repliedUser: false },
  });
  const click = await prompt
    .awaitMessageComponent({ filter: (i) => i.user.id === target.id, time: 60_000 })
    .catch(() => null);
  const accepted = click?.customId === "fam:yes";
  const result = accepted ? "Accepted." : click ? "Declined." : "The request expired.";
  if (click) await click.update({ content: `${target}, ${text}\n${result}`, components: [] });
  else await prompt.edit({ content: result, components: [] }).catch(() => undefined);
  return accepted;
}

function ancestors(id: string): Set<string> {
  const seen = new Set<string>();
  let current = fam(id).parent;
  while (current && !seen.has(current)) {
    seen.add(current);
    current = fam(current).parent;
  }
  return seen;
}

function tree(id: string): Set<string> {
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const f = fam(queue.shift()!);
    for (const next of [...f.partners, ...f.children, ...(f.parent ? [f.parent] : [])]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export const FAMILY_HANDLERS: Record<string, Handler> = {
  propose: async (ctx) => {
    const target = await targetOf(ctx, true);
    const me = ctx.member.id;
    if (target.bot || target.id === me) throw new CommandError("Pick another person to propose to.");
    if (fam(me).partners.includes(target.id)) throw new CommandError("You are already together.");
    if (ancestors(me).has(target.id) || ancestors(target.id).has(me) || fam(me).children.includes(target.id)) {
      throw new CommandError("You cannot marry a relative.");
    }
    if (!(await ask(ctx, target, `${ctx.member} proposed to you. Do you accept?`))) return;
    fam(me).partners.push(target.id);
    fam(target.id).partners.push(me);
    save();
    await ctx.ok(`${ctx.member} and ${target} are now married.`);
  },
  divorce: async (ctx) => {
    const mine = fam(ctx.member.id);
    const targetId = ctx.args[0] ? (await targetOf(ctx, true)).id : mine.partners[0];
    if (!targetId || !mine.partners.includes(targetId)) throw new CommandError("You are not married to that person.");
    mine.partners = mine.partners.filter((x) => x !== targetId);
    const theirs = fam(targetId);
    theirs.partners = theirs.partners.filter((x) => x !== ctx.member.id);
    save();
    await ctx.ok(`You divorced ${link(targetId)}.`);
  },
  adopt: async (ctx) => {
    const target = await targetOf(ctx, true);
    const me = ctx.member.id;
    if (target.bot || target.id === me) throw new CommandError("Pick another person to adopt.");
    if (fam(target.id).parent) throw new CommandError("That user already has a parent.");
    if (ancestors(me).has(target.id)) throw new CommandError("You cannot adopt your own ancestor.");
    if (!(await ask(ctx, target, `${ctx.member} wants to adopt you. Do you accept?`))) return;
    fam(me).children.push(target.id);
    fam(target.id).parent = me;
    save();
    await ctx.ok(`${ctx.member} adopted ${target}.`);
  },
  makeparent: async (ctx) => {
    const target = await targetOf(ctx, true);
    const me = ctx.member.id;
    if (target.bot || target.id === me) throw new CommandError("Pick another person.");
    if (fam(me).parent) throw new CommandError("You already have a parent.");
    if (ancestors(target.id).has(me)) throw new CommandError("You cannot make your descendant your parent.");
    if (!(await ask(ctx, target, `${ctx.member} wants you to be their parent. Do you accept?`))) return;
    fam(target.id).children.push(me);
    fam(me).parent = target.id;
    save();
    await ctx.ok(`${target} is now the parent of ${ctx.member}.`);
  },
  children: async (ctx) => {
    const user = await targetOf(ctx, false);
    const kids = fam(user.id).children;
    await ctx.reply(embed(kids.map(link).join("\n") || "No children.", `${user.username}'s children`));
  },
  parent: async (ctx) => {
    const user = await targetOf(ctx, false);
    const p = fam(user.id).parent;
    await ctx.reply(embed(p ? link(p) : "No parent.", `${user.username}'s parent`));
  },
  disown: async (ctx) => {
    const mine = fam(ctx.member.id);
    const childId = ctx.args[0] ? (await targetOf(ctx, true)).id : undefined;
    if (!childId || !mine.children.includes(childId)) throw new CommandError("That user is not your child.");
    mine.children = mine.children.filter((x) => x !== childId);
    delete fam(childId).parent;
    save();
    await ctx.ok(`You disowned ${link(childId)}.`);
  },
  emancipate: async (ctx) => {
    const mine = fam(ctx.member.id);
    if (!mine.parent) throw new CommandError("You do not have a parent.");
    const parent = fam(mine.parent);
    parent.children = parent.children.filter((x) => x !== ctx.member.id);
    delete mine.parent;
    save();
    await ctx.ok("You are now emancipated.");
  },
  familysize: async (ctx) => {
    const user = await targetOf(ctx, false);
    const size = tree(user.id).size;
    await ctx.reply(embed(`${user.username}'s family tree has **${size}** ${size === 1 ? "person" : "people"}.`));
  },
};
