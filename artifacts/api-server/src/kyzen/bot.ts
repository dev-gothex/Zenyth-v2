import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import { logger } from "../lib/logger";
import {
  createBotInfoButtons,
  createBotInfoEmbed,
  createHelpEmbed,
  createCommandPageEmbed,
  createCommandPageRows,
  createCommandReferenceEmbed,
  createCommandReferenceRows,
  createCommandSearchEmbed,
  createMentionEmbed,
  createModuleEmbed,
  createModuleSelectRow,
  getSelectedCommandPage,
  getSelectedInfoPage,
  getSelectedModule,
} from "./embeds";
import {
  findCommandReference,
  parseCommandReferenceInteraction,
} from "./command-reference";
import { runCommand } from "./commands/dispatcher";
import { startAutomation } from "./commands/handlers/automation";
import { startVanityWatcher } from "./commands/handlers/vanity";
import {
  ZENYTH_MODULES,
  ZENYTH_PREFIX,
} from "./modules";
import {
  COMMAND_CATALOG_COUNT,
  MODERATION_COMMAND_COUNT,
  UNCATEGORIZED_COMMAND_COUNT,
} from "./catalog";

export type ZenythBotState =
  | "disabled"
  | "connecting"
  | "ready"
  | "wrong_bot"
  | "error";

interface ZenythBotStatus {
  state: ZenythBotState;
  username: string | null;
  guildCount: number;
  prefix: string;
  commandCatalogLoaded: boolean;
}

const status: ZenythBotStatus = {
  state: "disabled",
  username: null,
  guildCount: 0,
  prefix: ZENYTH_PREFIX,
  commandCatalogLoaded: COMMAND_CATALOG_COUNT === 2278,
};

let botClient: Client | null = null;

export function getZenythBotStatus(): ZenythBotStatus {
  return { ...status };
}

export function getZenythCommandModules() {
  return ZENYTH_MODULES.map(({ id, name, commandCount, description }) => ({
    id,
    name,
    commandCount,
    description,
    sourceCategoryMapped: id === "moderation",
    cataloguedCommandCount:
      id === "moderation"
        ? MODERATION_COMMAND_COUNT
        : 0,
  }));
}

export async function startZenythBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    status.state = "disabled";
      logger.warn("Discord bot is disabled because DISCORD_BOT_TOKEN is not set");
    return;
  }

  if (botClient) {
    return;
  }

  status.state = "connecting";
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildModeration,
    ],
  });
  botClient = client;
  startVanityWatcher(client);
  startAutomation(client);

  client.once(Events.ClientReady, (readyClient) => {
    status.username = readyClient.user.username;
    status.guildCount = readyClient.guilds.cache.size;

    if (readyClient.user.username.toLowerCase() !== "zenyth") {
      status.state = "wrong_bot";
      logger.error(
        {
          connectedUsername: readyClient.user.username,
          expectedUsername: "Zenyth",
        },
        "Discord token belongs to a different bot; Zenyth will not respond",
      );
      botClient = null;
      void readyClient.destroy();
      return;
    }

    status.state = "ready";
    logger.info(
      { username: status.username, guildCount: status.guildCount },
      "Zenyth Discord bot connected",
    );
  });

  client.on(Events.GuildCreate, () => {
    status.guildCount = client.guilds.cache.size;
  });
  client.on(Events.GuildDelete, () => {
    status.guildCount = client.guilds.cache.size;
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    if (
      client.user &&
      message.mentions.users.has(client.user.id) &&
      !message.content.startsWith(ZENYTH_PREFIX)
    ) {
      try {
        await message.channel.send({
          embeds: [createMentionEmbed(message.author.id, ZENYTH_PREFIX)],
          allowedMentions: {
            parse: [],
            users: [message.author.id],
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Zenyth failed to reply to a mention");
      }
      return;
    }

    if (!message.content.startsWith(ZENYTH_PREFIX)) return;

    const commandText = message.content
      .slice(ZENYTH_PREFIX.length)
      .trim();
    const [rawCommand, ...args] = commandText.split(/\s+/);
    const command = rawCommand?.toLowerCase();

    try {
      if (command === "help" || command === "commands") {
        const query = args.join(" ").trim();
        if (query) {
          const reference = findCommandReference(query);
          await message.reply(
            reference
              ? {
                  embeds: [createCommandReferenceEmbed(reference)],
                  components: [createCommandReferenceRows(reference)],
                  allowedMentions: { parse: [] },
                }
              : {
                  embeds: [createCommandSearchEmbed(query)],
                  allowedMentions: { parse: [] },
                },
          );
        } else {
          await message.reply({
            embeds: [createHelpEmbed(client)],
            components: [createModuleSelectRow()],
            allowedMentions: { parse: [] },
          });
        }
      } else if (command === "botinfo") {
        await message.reply({
          embeds: [createBotInfoEmbed(client)],
          components: [createBotInfoButtons()],
          allowedMentions: { parse: [] },
        });
      } else if (message.inGuild()) {
        await runCommand(client, message, commandText);
      }
    } catch (error) {
      logger.error({ err: error }, "Zenyth failed to reply to a command");
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === "zenyth:module"
      ) {
        const module = getSelectedModule(interaction);
        if (!module) {
          await interaction.reply({
            content: "That module is no longer available.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.update({
          embeds: [createModuleEmbed(module, client)],
          components: [createModuleSelectRow()],
        });
        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId === "zenyth:ref:close"
      ) {
        await interaction.deferUpdate();
        await interaction.message.delete();
        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith("zenyth:ref:")
      ) {
        const parsed = parseCommandReferenceInteraction(interaction.customId);
        if (!parsed) {
          await interaction.reply({
            content: "That command reference page is no longer available.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const selection =
          parsed.action === "sort"
            ? { ...parsed.selection, sorted: !parsed.selection.sorted }
            : parsed.selection;
        await interaction.update({
          embeds: [createCommandReferenceEmbed(selection)],
          components: [createCommandReferenceRows(selection)],
        });
        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith("zenyth:page:")
      ) {
        const pageSelection = getSelectedCommandPage(interaction);
        if (!pageSelection) {
          await interaction.reply({
            content: "That command page is no longer available.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.update({
          embeds: [
            createCommandPageEmbed(
              pageSelection.group,
              pageSelection.page,
            ),
          ],
          components: createCommandPageRows(
            pageSelection.group,
            pageSelection.page,
          ),
        });
        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith("zenyth:info:")
      ) {
        const page = getSelectedInfoPage(interaction);
        await interaction.update({
          embeds: [createBotInfoEmbed(client, page)],
          components: [createBotInfoButtons()],
        });
      }
    } catch (error) {
      logger.error({ err: error }, "Zenyth failed to handle an interaction");
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Zenyth could not update this message. Please try again.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Zenyth Discord client error");
  });

  try {
    await client.login(token);
  } catch (error) {
    status.state = "error";
    botClient = null;
    logger.error({ err: error }, "Zenyth could not connect to Discord");
  }
}
