import { EmbedBuilder } from "discord.js";
import { parseUser } from "../args";
import { type Ctx, type Handler } from "../types";
import { WHITE, embed } from "../ui";
import { globalData } from "../../store";

/** name -> [with a target, on their own]. {a} is the author, {b} the target. */
const ACTIONS: Record<string, [string, string]> = {
  angry: ["{a} is angry at {b}.", "{a} is angry."],
  baka: ["{a} calls {b} a baka.", "{a} is being a baka."],
  bite: ["{a} bites {b}.", "{a} bites the air."],
  bleh: ["{a} sticks their tongue out at {b}.", "{a} sticks their tongue out."],
  blowkiss: ["{a} blows a kiss to {b}.", "{a} blows a kiss."],
  blush: ["{a} blushes at {b}.", "{a} blushes."],
  bonk: ["{a} bonks {b}.", "{a} bonks the air."],
  carry: ["{a} carries {b}.", "{a} carries nobody."],
  clap: ["{a} claps for {b}.", "{a} claps."],
  confused: ["{a} is confused by {b}.", "{a} is confused."],
  cry: ["{a} cries on {b}.", "{a} cries."],
  cuddle: ["{a} cuddles {b}.", "{a} wants a cuddle."],
  dance: ["{a} dances with {b}.", "{a} dances."],
  facepalm: ["{a} facepalms at {b}.", "{a} facepalms."],
  handhold: ["{a} holds hands with {b}.", "{a} wants to hold hands."],
  handshake: ["{a} shakes hands with {b}.", "{a} offers a handshake."],
  happy: ["{a} is happy with {b}.", "{a} is happy."],
  highfive: ["{a} high fives {b}.", "{a} high fives the air."],
  hug: ["{a} hugs {b}.", "{a} wants a hug."],
  kabedon: ["{a} pins {b} against the wall.", "{a} stares at the wall."],
  kiss: ["{a} kisses {b}.", "{a} blows a kiss."],
  laugh: ["{a} laughs at {b}.", "{a} laughs."],
  lurk: ["{a} lurks behind {b}.", "{a} lurks."],
  nom: ["{a} nibbles on {b}.", "{a} nibbles on something."],
  nope: ["{a} says nope to {b}.", "{a} says nope."],
  nya: ["{a} nyas at {b}.", "{a} nyas."],
  pat: ["{a} pats {b}.", "{a} wants a pat."],
  peck: ["{a} pecks {b}.", "{a} blows a peck."],
  poke: ["{a} pokes {b}.", "{a} pokes the air."],
  pout: ["{a} pouts at {b}.", "{a} pouts."],
  pray: ["{a} prays for {b}.", "{a} prays."],
  punch: ["{a} punches {b}.", "{a} punches the air."],
  salute: ["{a} salutes {b}.", "{a} salutes."],
  shake: ["{a} shakes {b}.", "{a} shakes."],
  shocked: ["{a} is shocked by {b}.", "{a} is shocked."],
  shoot: ["{a} shoots {b}.", "{a} shoots at nothing."],
  shrug: ["{a} shrugs at {b}.", "{a} shrugs."],
  sip: ["{a} sips a drink next to {b}.", "{a} sips a drink."],
  slap: ["{a} slaps {b}.", "{a} slaps the air."],
  sleep: ["{a} sleeps next to {b}.", "{a} falls asleep."],
  smack: ["{a} smacks {b}.", "{a} smacks the air."],
  smile: ["{a} smiles at {b}.", "{a} smiles."],
  smug: ["{a} smirks at {b}.", "{a} smirks."],
  stare: ["{a} stares at {b}.", "{a} stares into the distance."],
  teehee: ["{a} giggles at {b}.", "{a} giggles."],
  think: ["{a} thinks about {b}.", "{a} is thinking."],
  thumbsup: ["{a} gives {b} a thumbs up.", "{a} gives a thumbs up."],
  tickle: ["{a} tickles {b}.", "{a} tickles the air."],
  wag: ["{a} wags their tail at {b}.", "{a} wags their tail."],
  wave: ["{a} waves at {b}.", "{a} waves."],
  wink: ["{a} winks at {b}.", "{a} winks."],
  yawn: ["{a} yawns at {b}.", "{a} yawns."],
  yeet: ["{a} yeets {b}.", "{a} yeets themselves."],
};

async function gif(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://nekos.best/api/v2/${name}`, {
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: { url?: string }[] };
    return body.results?.[0]?.url ?? null;
  } catch {
    return null;
  }
}

function action(name: string, [withTarget, solo]: [string, string]): Handler {
  return async (ctx: Ctx) => {
    const target = ctx.args[0] ? await parseUser(ctx, ctx.args[0]) : null;
    const a = `**${ctx.member.displayName}**`;
    const text = (target && target.id !== ctx.member.id ? withTarget : solo)
      .replaceAll("{a}", a)
      .replaceAll("{b}", `**${target?.displayName ?? target?.username ?? ""}**`);
    const url = await gif(name);
    const e = new EmbedBuilder().setColor(WHITE).setDescription(text);
    if (url) e.setImage(url);
    await ctx.reply(e);
  };
}

export const ROLEPLAY_HANDLERS: Record<string, Handler> = {
  ...Object.fromEntries(Object.entries(ACTIONS).map(([name, pair]) => [name, action(name, pair)])),
  ship: async (ctx) => {
    const target = ctx.args[0] ? await parseUser(ctx, ctx.args[0]) : null;
    if (!target) {
      await ctx.fail("I could not find that user.");
      return;
    }
    const [x, y] = [ctx.member.id, target.id].sort();
    let hash = 0;
    for (const ch of `${x}${y}`) hash = (hash * 31 + ch.charCodeAt(0)) % 101;
    const filled = Math.round(hash / 10);
    const bar = "#".repeat(filled) + "-".repeat(10 - filled);
    const card = embed(`**${ctx.member.displayName}** and **${target.displayName}**\n\`[${bar}]\` **${hash}%**`, "Compatibility");
    const images = (globalData().shipImages ?? []) as string[];
    if (images.length) card.setImage(images[Math.floor(Math.random() * images.length)]);
    await ctx.reply(card);
  },
};
