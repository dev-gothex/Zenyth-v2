import { readdirSync, readFileSync, statfsSync } from "node:fs";
import * as os from "node:os";
import { extname, join } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  version as discordJsVersion,
  type ButtonInteraction,
  type Client,
  type StringSelectMenuInteraction,
  escapeMarkdown,
} from "discord.js";
import {
  createCommandReferenceCustomId,
  getCommandReferencePage,
  type CommandReferenceSelection,
} from "./command-reference";
import {
  ZENYTH_COMMAND_COUNT,
  ZENYTH_MODULES,
  ZENYTH_PREFIX,
  type ZenythModule,
} from "./modules";
import { getCommandsForGroup } from "./catalog";
import { getAliases, getPermissionLabel } from "./meta";
import { staffLists } from "./staff";

const mentionList = (ids: string[]) => ids.map((id) => `<@${id}>`).join(", ") || "None";
import rawModuleCommandSummaries from "./module-command-summaries.json";

const EMBED_WHITE = 0xffffff;
const WEBSITE_URL = "https://zenythbot.in";
const GET_STARTED_DOCUMENTATION_URL = "https://zenythbot.in";
const DOCUMENTATION_URL = "https://zenythbot.in/documentation";
const SUPPORT_SERVER_URL = "https://discord.gg/ztZwb9fGyZ";
const PARTNER_SERVER_URL = "https://discord.gg/singles";
const INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=1561603585635258398&permissions=8&integration_type=0&scope=bot+applications.commands";
const OWNER_ID = "1561255430838030338";
const COMMANDS_PER_PAGE = 12;
const MODULE_COMMAND_SUMMARIES = rawModuleCommandSummaries as Record<
  string,
  { name: string; subcommandCount: number }[]
>;

export function createHelpEmbed(client: Client): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_WHITE)
    .setDescription(
      [
        "# Get started with Zenyth",
        `> Run ${ZENYTH_PREFIX}help (command) for detailed info. Browse our [documentation](${GET_STARTED_DOCUMENTATION_URL}) to learn about zenyth & it's modules.`,
        "# Need help?",
        `> Join the [Support Server](${SUPPORT_SERVER_URL}) and open a ticket. The docs cover every feature in detail — check them before asking.`,
        "# Quick links",
        `> [Website](${WEBSITE_URL}) · [Documentation](${DOCUMENTATION_URL}) · [Support](${SUPPORT_SERVER_URL}) · [Invite](${INVITE_URL})`,
      ].join("\n\n"),
    )
    .setFooter({
      text: `${ZENYTH_COMMAND_COUNT.toLocaleString()} commands across ${ZENYTH_MODULES.length} modules · Select a category below`,
    });
  const avatarUrl = client.user?.displayAvatarURL();

  embed.setAuthor({
    name: "Zenyth",
    ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  });

  if (avatarUrl) {
    embed.setThumbnail(avatarUrl);
  }

  return embed;
}

export function createMentionEmbed(
  userId: string,
  prefix: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_WHITE)
    .setDescription(
      `Hey <@${userId}>, my prefix in this server is \`${prefix}\`.`,
    );
}

export function createModuleSelectRow(): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId("zenyth:module")
    .setPlaceholder("Select a module...")
    .addOptions(
      [
        ...ZENYTH_MODULES.map((module) => ({
          label: module.name,
          value: module.id,
          description: `${module.commandCount} commands · ${module.description}`.slice(
            0,
            100,
          ),
        })),
      ],
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

export function createModuleEmbed(
  module: ZenythModule,
  client: Client,
): EmbedBuilder {
  const commands = MODULE_COMMAND_SUMMARIES[module.id];
  if (!commands) {
    throw new Error(`No command summary found for module "${module.id}".`);
  }
  const commandList = commands
    .map(({ name, subcommandCount }) =>
      subcommandCount > 0 ? `${name} [${subcommandCount}]` : name,
    )
    .join(", ");
  const avatarUrl = client.user?.displayAvatarURL();
  const embed = new EmbedBuilder()
    .setColor(EMBED_WHITE)
    .setAuthor({
      name: "Zenyth",
      ...(avatarUrl ? { iconURL: avatarUrl } : {}),
    })
    .setDescription(
      [
        `> ${module.description}`,
        `**${module.name}**`,
        `\`\`\`\n${commandList}\n\`\`\``,
      ].join("\n\n"),
    )
    .setFooter({
      text: `${module.commandCount.toLocaleString()} commands · ${ZENYTH_PREFIX}help (command) for details`,
    });

  if (avatarUrl) {
    embed.setThumbnail(avatarUrl);
  }

  return embed;
}

export function createCommandPageEmbed(
  group: "moderation",
  requestedPage: number,
): EmbedBuilder {
  const commands = getCommandsForGroup(group);
  const pageCount = Math.max(1, Math.ceil(commands.length / COMMANDS_PER_PAGE));
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  const first = page * COMMANDS_PER_PAGE;
  const pageCommands = commands.slice(first, first + COMMANDS_PER_PAGE);
  const lines = pageCommands.map((command) => {
    const indent = "  ".repeat(Math.min(command.depth, 5));
    const name = escapeMarkdown(command.name);
    const description = escapeMarkdown(command.description);
    return `${indent}**${name}**${description ? `\n${indent}${description}` : ""}`;
  });
  return new EmbedBuilder()
    .setColor(EMBED_WHITE)
    .setAuthor({ name: "Zenyth Help" })
    .setTitle("Moderation commands")
    .setDescription(lines.join("\n\n") || "No command entries found.")
    .setFooter({
      text: `${first + 1}-${Math.min(first + pageCommands.length, commands.length)} of ${commands.length} commands · Page ${page + 1}/${pageCount}`,
    });
}

export function createCommandSearchEmbed(query: string): EmbedBuilder {
  const normalizedQuery = query.trim().toLowerCase();
  const commands = ZENYTH_COMMAND_COUNT
    ? getCommandsForGroup("moderation").concat(getCommandsForGroup("other"))
    : [];
  const nameMatches = commands.filter((command) =>
    command.name.toLowerCase().includes(normalizedQuery),
  );
  const descriptionMatches = commands.filter(
    (command) =>
      !command.name.toLowerCase().includes(normalizedQuery) &&
      command.description.toLowerCase().includes(normalizedQuery),
  );
  const results = [...nameMatches, ...descriptionMatches].slice(0, 10);
  const lines = results.map(
    (command) =>
      `**${escapeMarkdown(command.name)}**${command.description ? `\n${escapeMarkdown(command.description)}` : ""}`,
  );

  return new EmbedBuilder()
    .setColor(EMBED_WHITE)
    .setAuthor({ name: "Zenyth Help" })
    .setTitle(`Command search: ${escapeMarkdown(query.trim().slice(0, 80))}`)
    .setDescription(
      lines.join("\n\n") ||
        `No catalog entries matched \`${escapeMarkdown(query.trim())}\`.`,
    )
    .setFooter({
      text: `${Math.min(nameMatches.length + descriptionMatches.length, 10)} results shown`,
    });
}

export function createCommandReferenceEmbed(
  selection: CommandReferenceSelection,
): EmbedBuilder {
  const reference = getCommandReferencePage(selection);
  if (!reference) {
    throw new Error("The requested command reference page is unavailable.");
  }
  const module = ZENYTH_MODULES.find(
    (candidate) => candidate.id === selection.moduleId,
  );
  if (!module) {
    throw new Error(`No module found for "${selection.moduleId}".`);
  }

  const { currentEntry, entries, group } = reference;
  const parameters =
    currentEntry.parameters
      .map(
        ({ name, required }) =>
          `\`${name}\`${required ? "" : " (optional)"}`,
      )
      .join(", ") || "N/A";
  const aliases = getAliases(currentEntry.path).join(", ") || "N/A";
  const permissions = getPermissionLabel(
    selection.moduleId,
    currentEntry.path,
  );
  const exampleArguments = currentEntry.parameters
    .map(({ name, required }) => {
      const sample = getExampleValue(name);
      return required ? sample : `[${sample}]`;
    })
    .join(" ");
  const example = `${ZENYTH_PREFIX}${currentEntry.path}${
    exampleArguments ? ` ${exampleArguments}` : ""
  }`;
  const title =
    currentEntry.path === reference.scopeEntry.path
      ? `Group: ${escapeMarkdown(currentEntry.path)}`
      : `Command: ${escapeMarkdown(currentEntry.path)}`;

  return new EmbedBuilder()
    .setColor(EMBED_WHITE)
    .setTitle(title)
    .setDescription(
      [
        `> ${currentEntry.description ? escapeMarkdown(currentEntry.description) : "No description available."}`,
        `**Permissions**\n${permissions}`,
        `**Parameters**\n${parameters}`,
        `**Usage**\n\`\`\`\nSyntax: ${currentEntry.signature}\nExample: ${example}\n\`\`\``,
      ].join("\n\n"),
    )
    .setFooter({
      text: `Module: ${module.name} • Aliases: ${aliases} • Page ${selection.page + 1}/${entries.length} (entries: ${entries.length})`,
    });
}

export function createCommandReferenceRows(
  selection: CommandReferenceSelection,
): ActionRowBuilder<ButtonBuilder> {
  const reference = getCommandReferencePage(selection);
  if (!reference) {
    throw new Error("The requested command reference page is unavailable.");
  }

  const lastPage = reference.entries.length - 1;
  const previousSelection = {
    ...selection,
    page: Math.max(0, selection.page - 1),
  };
  const nextSelection = {
    ...selection,
    page: Math.min(lastPage, selection.page + 1),
  };

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        createCommandReferenceCustomId("page", previousSelection),
      )
      .setLabel("‹")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(selection.page === 0),
    new ButtonBuilder()
      .setCustomId(createCommandReferenceCustomId("page", nextSelection))
      .setLabel("›")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(selection.page === lastPage),
    new ButtonBuilder()
      .setCustomId(createCommandReferenceCustomId("sort", selection))
      .setLabel("⇅")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("zenyth:ref:close")
      .setLabel("×")
      .setStyle(ButtonStyle.Danger),
  );
}

export function createCommandPageRows(
  group: "moderation",
  requestedPage: number,
): [
  ActionRowBuilder<StringSelectMenuBuilder>,
  ActionRowBuilder<ButtonBuilder>,
] {
  const commands = getCommandsForGroup(group);
  const lastPage = Math.max(
    0,
    Math.ceil(commands.length / COMMANDS_PER_PAGE) - 1,
  );
  const page = Math.max(0, Math.min(requestedPage, lastPage));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`zenyth:page:${group}:${page - 1}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`zenyth:page:${group}:${page + 1}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === lastPage),
  );

  return [createModuleSelectRow(), buttons];
}

export function createBotInfoEmbed(
  client: Client,
  page = "system",
): EmbedBuilder {
  const botUser = client.user;
  const embed = new EmbedBuilder().setColor(EMBED_WHITE);

  if (page === "general") {
    const codebase = getCodebaseMetrics();
    const createdDate = botUser
      ? new Date(botUser.createdTimestamp).toLocaleDateString("en-US", {
          timeZone: "UTC",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : "Unavailable";
    const verified = botUser?.flags
      ? botUser.flags.toArray().some((flag) => flag === "VerifiedBot")
        ? "Yes"
        : "No"
      : "Unavailable";
    const userCount = client.guilds.cache
      .reduce((total, guild) => total + (guild.memberCount ?? 0), 0)
      .toLocaleString();

    embed.setDescription(
      [
        formatInfoSection("Bot Core", [
          ["Name", botUser?.username ?? "Unavailable"],
          ["ID", botUser?.id ?? "Unavailable"],
          ["Created", createdDate],
          ["Verified", verified],
        ]),
        formatInfoSection("Codebase", [
          [
            "Source Files",
            codebase?.files.toLocaleString() ?? "Unavailable",
          ],
          ["Lines", codebase?.lines.toLocaleString() ?? "Unavailable"],
          ["Words", codebase?.words.toLocaleString() ?? "Unavailable"],
          ["Framework", `discord.js ${discordJsVersion}`],
        ]),
        formatInfoSection("Network", [
          ["Ping", `${Math.max(0, Math.round(client.ws.ping))} ms`],
          ["Servers", client.guilds.cache.size.toLocaleString()],
          ["Users", userCount],
        ]),
      ].join("\n\n"),
    );
  } else if (page === "team") {
    embed
      .setTitle("Team Information")
      .setDescription(
        [
          `**Owners**\n${mentionList(staffLists().owners)}`,
          `**Developers**\n${mentionList([...new Set([...staffLists().owners, ...staffLists().devs])])}`,
          `**Core Team**\n${mentionList([...new Set([...staffLists().owners, ...staffLists().core])])}`,
        ].join("\n\n"),
      );
  } else if (page === "partners") {
    embed
      .setTitle("Partner Servers")
      .setDescription(`[/ Singles 🦋 | Indian • Gws • Hangout • Chilling • Fun • Vc](${PARTNER_SERVER_URL})`);
  } else {
    const processors = os.cpus();
    const logicalCores = processors.length;
    const uptimeSeconds = process.uptime();
    const cpuTime = process.cpuUsage();
    const cpuCapacity = Math.max(1, uptimeSeconds * 1_000_000 * logicalCores);
    const processCpuPercent = Math.min(
      100,
      ((cpuTime.user + cpuTime.system) / cpuCapacity) * 100,
    );
    const totalRam = os.totalmem();
    const availableRam = os.freemem();
    const ramUsagePercent =
      totalRam > 0 ? ((totalRam - availableRam) / totalRam) * 100 : 0;
    const memory = process.memoryUsage();
    const userCount = client.guilds.cache.reduce(
      (total, guild) => total + (guild.memberCount ?? 0),
      0,
    );

    embed.setDescription(
      [
        formatInfoSection("Hardware", [
          ["CPU Cores", `${logicalCores} logical`],
          [
            "Frequency",
            processors[0]?.speed && processors[0].speed > 0
              ? `${processors[0].speed.toLocaleString()} MHz`
              : "Not reported",
          ],
          ["Process CPU", `${processCpuPercent.toFixed(1)}%`],
          ["Architecture", os.arch()],
          ["Processor", processors[0]?.model ?? "Not reported"],
        ]),
        formatInfoSection("Memory", [
          ["Total RAM", formatGigabytes(totalRam)],
          ["Available", formatGigabytes(availableRam)],
          ["RAM Usage", `${ramUsagePercent.toFixed(0)}%`],
          ["Disk Usage", getDiskUsage()],
          ["Process RSS", formatGigabytes(memory.rss)],
          ["PID", String(process.pid)],
        ]),
        formatInfoSection("Platform", [
          ["OS", `${os.type()} ${os.release()}`],
          ["Node.js", process.versions.node],
          ["Discord.js", discordJsVersion],
          ["Runtime", "Node.js"],
        ]),
        formatInfoSection("Network", [
          ["Shards", String(client.ws.shards.size)],
          ["Ping", `${Math.max(0, Math.round(client.ws.ping))} ms`],
          ["Servers", client.guilds.cache.size.toLocaleString()],
          ["Users", userCount.toLocaleString()],
        ]),
        formatInfoSection("Uptime", [
          ["Duration", formatDuration(uptimeSeconds)],
          ["Since", formatElapsedAgo(uptimeSeconds)],
        ]),
        formatInfoSection("Commands", [
          ["Prefix", ZENYTH_PREFIX],
          ["Catalog", ZENYTH_COMMAND_COUNT.toLocaleString()],
          ["Modules", String(ZENYTH_MODULES.length)],
          ["Implemented", "help, commands, botinfo"],
        ]),
      ].join("\n\n"),
    );
  }

  const avatarUrl = botUser?.displayAvatarURL();
  embed.setAuthor({
    name: "Zenyth",
    ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  });

  return embed.setFooter({
    text: `Zenyth Information | Today at ${formatCurrentTime()}`,
    ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  });
}

export function createBotInfoButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("zenyth:info:system")
      .setLabel("System")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("zenyth:info:general")
      .setLabel("General")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("zenyth:info:team")
      .setLabel("Team Info")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("zenyth:info:partners")
      .setLabel("Partner Servers")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function getSelectedModule(
  interaction: StringSelectMenuInteraction,
): ZenythModule | undefined {
  const selectedId = interaction.values[0];
  return ZENYTH_MODULES.find((module) => module.id === selectedId);
}

export function getSelectedCommandPage(interaction: ButtonInteraction):
  | { group: "moderation"; page: number }
  | undefined {
  const [brand, action, group, rawPage] = interaction.customId.split(":");
  if (brand !== "zenyth" || action !== "page") return undefined;
  if (group !== "moderation") return undefined;
  const page = Number(rawPage);
  if (!Number.isInteger(page) || page < 0) return undefined;
  return { group: "moderation", page };
}

export function getSelectedInfoPage(
  interaction: ButtonInteraction,
): string | undefined {
  return interaction.customId.split(":")[2];
}

function formatDuration(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainder = totalSeconds % 60;

  return `${days}d ${hours}h ${minutes}m ${remainder}s`;
}

function formatInfoSection(
  title: string,
  entries: [string, string][],
): string {
  const rows = entries
    .map(([label, value]) => {
      const safeValue = value.replace(/`/g, "ˋ").replace(/\r?\n/g, " ");
      return `> **${label}** \`${safeValue}\``;
    })
    .join("\n");
  return `**${title}**\n${rows}`;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function getDiskUsage(): string {
  try {
    const filesystem = statfsSync(process.cwd());
    const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      return "Unavailable";
    }
    const usedPercent = Math.max(
      0,
      Math.min(100, ((totalBytes - availableBytes) / totalBytes) * 100),
    );
    return `${usedPercent.toFixed(0)}%`;
  } catch {
    return "Unavailable";
  }
}

function getCodebaseMetrics():
  | { files: number; lines: number; words: number }
  | undefined {
  const sourceRoot = join(process.cwd(), "src");
  const sourceFiles: string[] = [];

  const collectFiles = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        collectFiles(filePath);
      } else if (
        entry.isFile() &&
        [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(
          extname(entry.name),
        )
      ) {
        sourceFiles.push(filePath);
      }
    }
  };

  try {
    collectFiles(sourceRoot);
    let lines = 0;
    let words = 0;
    for (const filePath of sourceFiles) {
      const contents = readFileSync(filePath, "utf8");
      lines += contents.split(/\r?\n/).length;
      words += contents.match(/\S+/g)?.length ?? 0;
    }
    return { files: sourceFiles.length, lines, words };
  } catch {
    return undefined;
  }
}

function formatElapsedAgo(seconds: number): string {
  const elapsed = Math.floor(seconds);
  if (elapsed < 60) return "less than a minute ago";

  const days = Math.floor(elapsed / 86_400);
  if (days > 0) return days === 1 ? "a day ago" : `${days} days ago`;

  const hours = Math.floor(elapsed / 3_600);
  if (hours > 0) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const minutes = Math.floor(elapsed / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

function formatCurrentTime(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function getExampleValue(parameterName: string): string {
  const normalized = parameterName.toLowerCase();
  if (normalized.includes("channel")) return "#channel";
  if (normalized.includes("role")) return "@role";
  if (
    normalized.includes("member") ||
    normalized.includes("user") ||
    normalized.includes("target")
  ) {
    return "@member";
  }
  if (normalized.includes("duration")) return "1h";
  if (
    normalized.includes("amount") ||
    normalized.includes("limit") ||
    normalized.includes("size")
  ) {
    return "10";
  }
  return `<${parameterName}>`;
}
