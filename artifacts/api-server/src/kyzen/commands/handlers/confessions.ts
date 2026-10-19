import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type Interaction,
} from "discord.js";
import { logger } from "../../../lib/logger";
import { guildData, save } from "../../store";
import { parseChannel, parseUser } from "../args";
import { CommandError, type Ctx, type Handler } from "../types";
import { WHITE, embed } from "../ui";

interface Config {
  channel?: string;
  logChannel?: string;
  muted: string[];
  count: number;
}
function cfg(guildId: string): Config {
  const bag = guildData(guildId);
  bag.confessions ??= { muted: [], count: 0 } satisfies Config;
  return bag.confessions as Config;
}

async function textChannelArg(ctx: Ctx) {
  const ch = parseChannel(ctx, ctx.args[0]);
  if (!ch?.isTextBased()) throw new CommandError("I could not find that text channel.");
  return ch;
}

export const CONFESSION_HANDLERS: Record<string, Handler> = {
  "confessions enable": async (ctx) => {
    const ch = await textChannelArg(ctx);
    cfg(ctx.guild.id).channel = ch.id;
    save();
    await ctx.ok(`Confessions will be posted in ${ch}. Use \`${ctx.prefix}confessions panel (channel)\` to add the submit button.`);
  },
  "confessions disable": async (ctx) => {
    cfg(ctx.guild.id).channel = undefined;
    save();
    await ctx.ok("Confessions are now disabled.");
  },
  "confessions panel": async (ctx) => {
    const ch = await textChannelArg(ctx);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("confess:new").setLabel("Submit a confession").setStyle(ButtonStyle.Secondary),
    );
    await ch.send({ embeds: [embed("Press the button below to send an anonymous confession.", "Confessions")], components: [row] });
    await ctx.ok(`Sent the confession panel to ${ch}.`);
  },
  "confessions mute": async (ctx) => {
    const user = await parseUser(ctx, ctx.args[0]);
    if (!user) throw new CommandError("I could not find that user.");
    const c = cfg(ctx.guild.id);
    if (!c.muted.includes(user.id)) c.muted.push(user.id);
    save();
    await ctx.ok(`${user} can no longer use confessions.`);
  },
  "confessions unmute": async (ctx) => {
    const user = await parseUser(ctx, ctx.args[0]);
    if (!user) throw new CommandError("I could not find that user.");
    const c = cfg(ctx.guild.id);
    c.muted = c.muted.filter((id) => id !== user.id);
    save();
    await ctx.ok(`${user} can use confessions again.`);
  },
  "confessions mutelist": async (ctx) => {
    await ctx.reply(embed(cfg(ctx.guild.id).muted.map((id) => `<@${id}>`).join("\n") || "Nobody is muted.", "Muted from confessions"));
  },
  "confessions reset": async (ctx) => {
    delete guildData(ctx.guild.id).confessions;
    save();
    await ctx.ok("Reset all confession settings.");
  },
  "confessions logs setup": async (ctx) => {
    const ch = await textChannelArg(ctx);
    cfg(ctx.guild.id).logChannel = ch.id;
    save();
    await ctx.ok(`Confession logs will be sent to ${ch}.`);
  },
  "confessions logs view": async (ctx) => {
    const id = cfg(ctx.guild.id).logChannel;
    await ctx.ok(id ? `Logs are sent to <#${id}>.` : "No log channel is set.");
  },
  "confessions logs reset": async (ctx) => {
    cfg(ctx.guild.id).logChannel = undefined;
    save();
    await ctx.ok("Removed the confession log channel.");
  },
};

function modal(id: string, title: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("text").setLabel("Message").setStyle(TextInputStyle.Paragraph).setMaxLength(1800).setRequired(true),
      ),
    );
}

async function handle(interaction: Interaction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return;
  const guild = interaction.guild;
  const c = cfg(guild.id);

  if (interaction.isButton() && interaction.customId.startsWith("confess:")) {
    if (!c.channel) {
      await interaction.reply({ content: "Confessions are disabled.", flags: MessageFlags.Ephemeral });
    } else if (c.muted.includes(interaction.user.id)) {
      await interaction.reply({ content: "You are muted from confessions.", flags: MessageFlags.Ephemeral });
    } else if (interaction.customId === "confess:new") {
      await interaction.showModal(modal("confess:submit", "Anonymous confession"));
    } else if (interaction.customId === "confess:reply") {
      await interaction.showModal(modal(`confess:replysubmit:${interaction.message.id}`, "Anonymous reply"));
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("confess:")) {
    const text = interaction.fields.getTextInputValue("text");
    const channel = c.channel ? guild.channels.cache.get(c.channel) : undefined;
    if (!channel?.isTextBased() || c.muted.includes(interaction.user.id)) {
      await interaction.reply({ content: "Confessions are unavailable right now.", flags: MessageFlags.Ephemeral });
      return;
    }
    const isReply = interaction.customId.startsWith("confess:replysubmit:");
    c.count += 1;
    save();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("confess:reply").setLabel("Reply anonymously").setStyle(ButtonStyle.Secondary),
    );
    const card = new EmbedBuilder().setColor(WHITE).setTitle(isReply ? `Anonymous reply (#${c.count})` : `Anonymous confession #${c.count}`).setDescription(text);
    const posted = await channel.send({
      embeds: [card],
      components: [row],
      ...(isReply ? { reply: { messageReference: interaction.customId.split(":")[2], failIfNotExists: false } } : {}),
    });
    const log = c.logChannel ? guild.channels.cache.get(c.logChannel) : undefined;
    if (log?.isTextBased()) {
      await log.send({ embeds: [embed(`**Author:** ${interaction.user} (${interaction.user.id})\n**Post:** ${posted.url}\n\n${text}`, `Confession #${c.count} log`)], allowedMentions: { parse: [] } });
    }
    await interaction.reply({ content: "Your confession was posted anonymously.", flags: MessageFlags.Ephemeral });
  }
}

export function startConfessions(client: Client): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void handle(interaction).catch((err: unknown) => logger.error({ err }, "Confession interaction failed"));
  });
}
