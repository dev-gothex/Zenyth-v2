import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type Message,
  type TextChannel,
} from "discord.js";
import { guildData, save } from "../../store";
import { parseChannel } from "../args";
import { CommandError, type Ctx, type Handler } from "../types";
import { WHITE, embed } from "../ui";

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ======================= draft model ======================= */
export interface Draft {
  title?: string;
  description?: string;
  color?: number;
  thumbnail?: string;
  image?: string;
  footerText?: string;
  footerIcon?: string;
  authorName?: string;
  authorIcon?: string;
  fields: { name: string; value: string; inline: boolean }[];
}

const PH_TITLE = "Edit your Embed!";
const PH_DESC = "\u2022 Select Options what to edit from the below select menu.\n\nMust edit embed title & description to remove these instructions.";
const newDraft = (): Draft => ({ title: PH_TITLE, description: PH_DESC, color: WHITE, fields: [] });

export function buildEmbed(d: Draft): EmbedBuilder {
  const e = new EmbedBuilder().setColor(d.color ?? WHITE);
  if (d.title) e.setTitle(d.title);
  if (d.description) e.setDescription(d.description);
  if (d.thumbnail) e.setThumbnail(d.thumbnail);
  if (d.image) e.setImage(d.image);
  if (d.footerText) e.setFooter({ text: d.footerText, iconURL: d.footerIcon });
  if (d.authorName) e.setAuthor({ name: d.authorName, iconURL: d.authorIcon });
  if (d.fields.length) e.addFields(d.fields);
  if (!d.title && !d.description && !d.fields.length && !d.image && !d.thumbnail && !d.footerText && !d.authorName) e.setDescription("\u200b");
  return e;
}

/** Converts Discord embed JSON (or a message embed) into a draft. */
export function toDraft(json: any): Draft {
  const d: Draft = { fields: [] };
  if (typeof json.title === "string") d.title = json.title.slice(0, 256);
  if (typeof json.description === "string") d.description = json.description.slice(0, 4000);
  if (typeof json.color === "number") d.color = json.color;
  d.thumbnail = json.thumbnail?.url;
  d.image = json.image?.url;
  d.footerText = json.footer?.text;
  d.footerIcon = json.footer?.icon_url ?? json.footer?.iconURL;
  d.authorName = json.author?.name;
  d.authorIcon = json.author?.icon_url ?? json.author?.iconURL;
  if (Array.isArray(json.fields)) d.fields = json.fields.slice(0, 25).filter((f: any) => f?.name && f?.value).map((f: any) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: Boolean(f.inline) }));
  return d;
}

/* ======================= editing rules ======================= */
const NAMES: Record<string, number> = { white: 0xffffff, black: 0x000000, red: 0xed4245, green: 0x57f287, blue: 0x5865f2, yellow: 0xfee75c, orange: 0xe67e22, purple: 0x9b59b6, pink: 0xeb459e, grey: 0x99aab5, gray: 0x99aab5 };
export function parseColor(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t in NAMES) return NAMES[t];
  const hex = t.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/.test(hex)) return parseInt(hex, 16);
  if (/^[0-9a-f]{3}$/.test(hex)) return parseInt(hex.split("").map((c) => c + c).join(""), 16);
  return null;
}

type Key = "title" | "description" | "field" | "color" | "thumbnail" | "image" | "footerText" | "footerIcon" | "authorName" | "authorIcon";
const OPTIONS: { value: Key; label: string; what: string; prompt: string }[] = [
  { value: "title", label: "Title", what: "title", prompt: "Please enter the **Title of the embed**:" },
  { value: "description", label: "Description", what: "description", prompt: "Please enter the **Description of the embed**:" },
  { value: "field", label: "Add Field", what: "field", prompt: "Please enter the **Field** as `name | value` (add `| inline` to show it inline):" },
  { value: "color", label: "Color", what: "color", prompt: "Please enter the **Color of the embed** (hex like `#ff0000`, or a name like `red`):" },
  { value: "thumbnail", label: "Thumbnail", what: "thumbnail", prompt: "Please send the **Thumbnail** image URL or attach an image:" },
  { value: "image", label: "Image", what: "image", prompt: "Please send the **Image** URL or attach an image:" },
  { value: "footerText", label: "Footer Text", what: "footer text", prompt: "Please enter the **Footer Text of the embed**:" },
  { value: "footerIcon", label: "Footer Icon", what: "footer icon", prompt: "Please send the **Footer Icon** URL or attach an image (the footer text must be set too):" },
  { value: "authorName", label: "Author Text", what: "author text", prompt: "Please enter the **Author Text of the embed**:" },
  { value: "authorIcon", label: "Author Icon", what: "author icon", prompt: "Please send the **Author Icon** URL or attach an image (the author text must be set too):" },
];
const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

/** Applies one edit. Returns an error message, or null on success. Typing `clear` removes the value. */
export function applyEdit(d: Draft, key: Key, input: string, attachmentUrl?: string): string | null {
  const text = input.trim();
  const clear = text.toLowerCase() === "clear";
  const limited = (max: number) => (text.length > max ? `That is too long. The limit is ${max} characters.` : null);
  const url = (set: (v?: string) => void): string | null => {
    if (clear) { set(undefined); return null; }
    const value = attachmentUrl ?? text;
    if (!isUrl(value)) return "Send a valid link starting with `http://` or `https://`, or attach an image.";
    set(value);
    return null;
  };
  switch (key) {
    case "title": { const e = limited(256); if (e) return e; d.title = clear || !text ? undefined : text; return null; }
    case "description": { const e = limited(4000); if (e) return e; d.description = clear || !text ? undefined : text; return null; }
    case "footerText": { const e = limited(2048); if (e) return e; d.footerText = clear || !text ? undefined : text; if (clear) d.footerIcon = undefined; return null; }
    case "authorName": { const e = limited(256); if (e) return e; d.authorName = clear || !text ? undefined : text; if (clear) d.authorIcon = undefined; return null; }
    case "thumbnail": return url((v) => { d.thumbnail = v; });
    case "image": return url((v) => { d.image = v; });
    case "footerIcon": return url((v) => { d.footerIcon = v; });
    case "authorIcon": return url((v) => { d.authorIcon = v; });
    case "color": {
      if (clear) { d.color = WHITE; return null; }
      const c = parseColor(text);
      if (c === null) return "I could not read that colour. Use a hex code like `#ff0000` or a name like `red`.";
      d.color = c;
      return null;
    }
    case "field": {
      if (clear) { d.fields = []; return null; }
      const [name, value, inline] = text.split("|").map((s) => s.trim());
      if (!name || !value) return "Use the format `name | value`.";
      if (name.length > 256 || value.length > 1024) return "A field name can have 256 characters and a value 1024.";
      if (d.fields.length >= 25) return "An embed can have at most 25 fields.";
      d.fields.push({ name, value, inline: /^(yes|true|inline|y)$/i.test(inline ?? "") });
      return null;
    }
  }
}

function readyToSend(d: Draft): string | null {
  if (d.title === PH_TITLE || d.description === PH_DESC) return "Edit the embed title & description first to remove the instructions.";
  if (!d.title && !d.description && !d.fields.length && !d.image && !d.thumbnail && !d.authorName && !d.footerText) return "The embed is empty. Add a title or description first.";
  if (buildEmbed(d).data && JSON.stringify(buildEmbed(d).toJSON()).length > 6000) return "The embed is too large (Discord allows about 6000 characters in total).";
  return null;
}

/* ======================= templates ======================= */
const templates = (g: string): Record<string, Draft> => ((guildData(g).embeds ??= {}) as Record<string, Draft>);
const NAME = /^[a-z0-9_-]{1,32}$/;
function cleanName(raw?: string): string | undefined {
  if (!raw) return undefined;
  const n = raw.toLowerCase();
  if (!NAME.test(n)) throw new CommandError("A name can use letters, numbers, `-` and `_` (up to 32 characters).");
  return n;
}

async function messageArg(ctx: Ctx, token?: string): Promise<Message> {
  const link = token?.match(/channels\/\d+\/(\d+)\/(\d+)/);
  const channel = link ? ctx.guild.channels.cache.get(link[1]) : ctx.message.channel;
  const id = link ? link[2] : token;
  const found = id && /^\d{15,22}$/.test(id) && channel?.isTextBased() ? await channel.messages.fetch(id).catch(() => null) : null;
  if (!found) throw new CommandError("I could not find that message. Use a message ID from this channel or a message link.");
  return found;
}
async function sendTarget(ctx: Ctx, token?: string): Promise<TextChannel> {
  const ch = token ? parseChannel(ctx, token) : ctx.message.channel;
  if (!ch?.isTextBased() || !("send" in ch)) throw new CommandError("I could not find that text channel.");
  return ch as TextChannel;
}

/* ======================= interactive editor ======================= */
const HEADER = "Example embed. You can customize everything.\n*Respond within 30 seconds to avoid time out.*";

async function sendEmoji(ctx: Ctx): Promise<{ id: string; name: string; animated: boolean } | undefined> {
  const list = await ctx.client.application?.emojis.fetch().catch(() => null);
  const hit = list?.find((e) => /send|embed/i.test(e.name ?? ""));
  return hit?.id && hit.name ? { id: hit.id, name: hit.name, animated: Boolean(hit.animated) } : undefined;
}

async function runEditor(ctx: Ctx, draft: Draft, opts: { name?: string; target?: Message }): Promise<void> {
  const emoji = await sendEmoji(ctx);
  const rows = (selected?: Key, disabled = false) => {
    const select = new StringSelectMenuBuilder().setCustomId("emb:select").setPlaceholder("Choose an option to edit the Embed").setDisabled(disabled).addOptions(
      OPTIONS.map((o) => ({ label: o.label, value: o.value, description: `Edit the ${o.what} of the embed`, default: o.value === selected })),
    );
    const send = new ButtonBuilder().setCustomId("emb:send").setLabel("Send Embed").setStyle(ButtonStyle.Success).setDisabled(disabled);
    if (emoji) send.setEmoji(emoji);
    const cancel = new ButtonBuilder().setCustomId("emb:cancel").setLabel("Cancel Setup").setStyle(ButtonStyle.Danger).setEmoji("\u{1F5D1}\uFE0F").setDisabled(disabled);
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), new ActionRowBuilder<ButtonBuilder>().addComponents(send, cancel)];
  };

  const channel = ctx.message.channel as TextChannel;
  const panel = await ctx.message.reply({ content: HEADER, embeds: [buildEmbed(draft)], components: rows(), allowedMentions: { repliedUser: false } });
  const collector = panel.createMessageComponentCollector({ idle: 600_000 });
  let busy = false;

  /** Asks a question in the channel and waits 30 seconds for the owner's reply. */
  const ask = async (text: string): Promise<Message | null> => {
    const prompt = await channel.send(text);
    const got = await channel.awaitMessages({ filter: (m) => m.author.id === ctx.member.id, max: 1, time: 30_000 });
    await prompt.delete().catch(() => undefined);
    return got.first() ?? null;
  };
  const note = async (text: string) => {
    const m = await channel.send(text);
    setTimeout(() => void m.delete().catch(() => undefined), 6000);
  };

  collector.on("collect", async (i) => {
    if (i.user.id !== ctx.member.id) return void (await i.reply({ content: "This editor belongs to someone else.", flags: MessageFlags.Ephemeral }));
    if (busy) return void (await i.reply({ content: "Finish the current prompt first.", flags: MessageFlags.Ephemeral }));
    busy = true;
    try {
      if (i.isStringSelectMenu()) {
        const key = i.values[0] as Key;
        const option = OPTIONS.find((o) => o.value === key)!;
        await i.update({ components: rows(key) });
        const reply = await ask(option.prompt);
        if (!reply) {
          await note("Timed out. Choose an option again when you are ready.");
        } else {
          const attachment = reply.attachments.first()?.url;
          const error = applyEdit(draft, key, reply.content, attachment);
          if (error) await note(error);
          if (!attachment) await reply.delete().catch(() => undefined); // keep it when the image lives in that message
        }
        await panel.edit({ embeds: [buildEmbed(draft)], components: rows() });
      } else if (i.isButton() && i.customId === "emb:cancel") {
        await i.deferUpdate();
        collector.stop("cancelled");
        await panel.delete().catch(() => undefined);
      } else if (i.isButton() && i.customId === "emb:send") {
        const problem = readyToSend(draft);
        if (problem) return void (await i.reply({ content: problem, flags: MessageFlags.Ephemeral }));
        await i.update({ components: rows(undefined, true) });

        if (opts.target) {
          await opts.target.edit({ embeds: [buildEmbed(draft)] });
          if (opts.name) { templates(ctx.guild.id)[opts.name] = draft; save(); }
          collector.stop("done");
          await panel.edit({ content: "Updated the embed message.", components: [] });
        } else {
          const where = await ask("Mention the channel to send the embed to, type `here` for this channel, or `save` to only save it as a template:");
          const answer = where?.content.trim().toLowerCase();
          if (!where || !answer) {
            await note("Timed out. Press Send Embed again when you are ready.");
            await panel.edit({ components: rows() });
          } else {
            await where.delete().catch(() => undefined);
            let result: string | null = null;
            if (answer === "save") {
              if (!opts.name) result = "Give the embed a name to save it: `embed create (name)`.";
            } else {
              const dest = answer === "here" ? channel : parseChannel(ctx, where.content.trim());
              if (!dest?.isTextBased() || !("send" in dest)) result = "I could not find that text channel.";
              else await (dest as TextChannel).send({ embeds: [buildEmbed(draft)] }).catch(() => { result = "I could not send there. Check my permissions in that channel."; });
            }
            if (result) {
              await note(result);
              await panel.edit({ components: rows() });
            } else {
              if (opts.name) { templates(ctx.guild.id)[opts.name] = draft; save(); }
              collector.stop("done");
              await panel.edit({ content: answer === "save" ? `Saved as \`${opts.name}\`.` : `Sent the embed${opts.name ? ` and saved it as \`${opts.name}\`` : ""}.`, components: [] });
            }
          }
        }
      }
    } finally {
      busy = false;
    }
  });
  collector.on("end", (_c, reason) => {
    if (reason === "idle") void panel.edit({ content: "The embed editor timed out.", components: [] }).catch(() => undefined);
  });
}

/* ======================= commands ======================= */
const create: Handler = async (ctx) => {
  const name = cleanName(ctx.args[0]);
  if (name && templates(ctx.guild.id)[name]) throw new CommandError(`A template named \`${name}\` already exists. Use \`${ctx.prefix}embed edit ${name}\` to change it.`);
  if (name && Object.keys(templates(ctx.guild.id)).length >= 25) throw new CommandError("You can save up to 25 embed templates.");
  await runEditor(ctx, newDraft(), { name });
};

export const EMBED_HANDLERS: Record<string, Handler> = {
  "embed create": create,
  "embed wizard": create,
  "embed edit": async (ctx) => {
    const token = ctx.args[0];
    if (!token) throw new CommandError(`Give a saved embed's name or a message ID/link. Use \`${ctx.prefix}embed list\` to see your templates.`);
    const saved = templates(ctx.guild.id)[token.toLowerCase()];
    if (saved) {
      await runEditor(ctx, structuredClone(saved), { name: token.toLowerCase() });
      return;
    }
    const message = await messageArg(ctx, token).catch(() => null);
    if (!message) throw new CommandError(`I have no template named \`${token}\`, and it is not a message I can find.`);
    if (message.author.id !== ctx.client.user?.id || !message.embeds[0]) throw new CommandError("I can only edit embeds in my own messages.");
    await runEditor(ctx, toDraft(message.embeds[0].toJSON()), { target: message });
  },
  "embed list": async (ctx) => {
    const names = Object.keys(templates(ctx.guild.id));
    await ctx.reply(embed(names.map((n) => `\`${n}\``).join(", ") || `No saved embeds yet. Use \`${ctx.prefix}embed create (name)\`.`, "Embed templates"));
  },
  "embed delete": async (ctx) => {
    const name = ctx.args[0].toLowerCase();
    if (!templates(ctx.guild.id)[name]) throw new CommandError("I could not find that template.");
    delete templates(ctx.guild.id)[name];
    save();
    await ctx.ok(`Deleted \`${name}\`.`);
  },
  "embed rename": async (ctx) => {
    const [from, to] = [ctx.args[0].toLowerCase(), cleanName(ctx.args[1])];
    const all = templates(ctx.guild.id);
    if (!all[from] || !to) throw new CommandError("Use `embed rename (old_name) (new_name)` with an existing template.");
    if (all[to]) throw new CommandError("That name is already used.");
    all[to] = all[from];
    delete all[from];
    save();
    await ctx.ok(`Renamed \`${from}\` to \`${to}\`.`);
  },
  "embed send": async (ctx) => {
    const draft = templates(ctx.guild.id)[ctx.args[0].toLowerCase()];
    if (!draft) throw new CommandError("I could not find that template.");
    const dest = await sendTarget(ctx, ctx.args[1]);
    await dest.send({ embeds: [buildEmbed(draft)] });
    if (dest.id !== ctx.message.channelId) await ctx.ok(`Sent it to ${dest}.`);
  },
  "embed copy": async (ctx) => {
    const message = await messageArg(ctx, ctx.args[0]);
    if (!message.embeds[0]) throw new CommandError("That message has no embed.");
    const json = JSON.stringify(message.embeds[0].toJSON(), null, 2);
    if (json.length < 1900) await ctx.reply(`\`\`\`json\n${json}\n\`\`\``);
    else await ctx.message.reply({ files: [{ attachment: Buffer.from(json), name: "embed.json" }], allowedMentions: { repliedUser: false } });
  },
  "embed clone": async (ctx) => {
    const message = await messageArg(ctx, ctx.args[0]);
    const dest = await sendTarget(ctx, ctx.args[1]);
    if (!message.embeds.length) throw new CommandError("That message has no embed.");
    await dest.send({ embeds: message.embeds.map((e) => EmbedBuilder.from(e)) });
    await ctx.ok(`Cloned the embed to ${dest}.`);
  },
  "embed import": async (ctx) => {
    const dest = await sendTarget(ctx, ctx.args[0]);
    const raw = ctx.raw.slice(ctx.args[0].length).trim().replace(/^```(?:json)?\n?|```$/g, "");
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { throw new CommandError("That is not valid JSON."); }
    const source = Array.isArray(parsed.embeds) ? parsed.embeds[0] : (parsed.embed ?? parsed);
    const draft = toDraft(source ?? {});
    const problem = readyToSend(draft);
    if (problem) throw new CommandError(problem);
    await dest.send({ embeds: [buildEmbed(draft)] });
    await ctx.ok(`Sent the embed to ${dest}.`);
  },
};
