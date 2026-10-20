import {
  PermissionFlagsBits,
  type Client,
  type EmbedBuilder,
  type Message,
} from "discord.js";
import { logger } from "../../lib/logger";
import rawDetails from "../module-command-details.json";
import {
  findCommandReference,
  type CommandReferenceGroup,
} from "../command-reference";
import {
  createCommandReferenceEmbed,
  createCommandReferenceRows,
} from "../embeds";
import {
  PERMISSION_BITS,
  getPermissionLabel,
  resolveRootAlias,
  resolveSubAlias,
} from "../meta";
import { guildPrefix } from "../prefix";
import { genericHandlerFor } from "./handlers/generic";
import { BARE_OK, HANDLERS } from "./handlers";
import {
  CommandError,
  UsageError,
  type Ctx,
  type Handler,
  type Indexed,
} from "./types";
import { embed } from "./ui";
import { hasBypass } from "./handlers/modlog";

const details = rawDetails as Record<string, CommandReferenceGroup[]>;
const INDEX = new Map<string, Indexed>();

for (const [moduleId, groups] of Object.entries(details)) {
  groups.forEach((group, groupIndex) => {
    group.entries.forEach((entry, entryIndex) => {
      const key = entry.path.toLowerCase();
      if (INDEX.has(key)) return; // first module wins on a name clash
      const hasChildren = group.entries.some(
        (other, i) =>
          i !== entryIndex &&
          other.depth === entry.depth + 1 &&
          other.path.startsWith(`${entry.path} `),
      );
      INDEX.set(key, { moduleId, groupIndex, entryIndex, entry, hasChildren });
    });
  });
}

/** Longest-path match, honouring aliases. */
export function resolveCommand(
  text: string,
): { indexed: Indexed; path: string; args: string[]; raw: string } | undefined {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  let path = resolveRootAlias(tokens[0].toLowerCase());
  let current = INDEX.get(path);
  if (!current) return undefined;
  let consumed = 1;
  while (consumed < tokens.length) {
    const next = `${path} ${resolveSubAlias(tokens[consumed].toLowerCase())}`;
    const hit = INDEX.get(next);
    if (!hit) break;
    current = hit;
    path = next;
    consumed += 1;
  }
  const args = tokens.slice(consumed);
  return { indexed: current, path, args, raw: args.join(" ") };
}

function handlerFor(indexed: Indexed): Handler | undefined {
  return (
    HANDLERS.get(indexed.entry.path.toLowerCase()) ??
    genericHandlerFor(indexed)
  );
}

async function showReference(message: Message<true>, path: string): Promise<void> {
  const selection = findCommandReference(path);
  if (!selection) return;
  await message.reply({
    embeds: [createCommandReferenceEmbed(selection)],
    components: [createCommandReferenceRows(selection)],
    allowedMentions: { parse: [] },
  });
}

function missingPermission(ctx: Ctx, label: string): boolean {
  const bit = PERMISSION_BITS[label];
  if (bit === undefined) return false;
  if (ctx.guild.ownerId === ctx.member.id) return false;
  if (ctx.indexed.moduleId === "moderation" && hasBypass(ctx.guild, ctx.member, ctx.path)) return false;
  const perms = ctx.member.permissions;
  return !(perms.has(PermissionFlagsBits.Administrator) || perms.has(bit));
}

export async function runCommand(
  client: Client,
  message: Message<true>,
  text: string,
): Promise<void> {
  const resolved = resolveCommand(text);
  if (!resolved) return;
  const { indexed, path, args, raw } = resolved;

  const handler = handlerFor(indexed);
  const requiredCount = indexed.entry.parameters.filter((p) => p.required).length;
  const bareOk = args.length === 0 && BARE_OK.has(indexed.entry.path.toLowerCase());
  const showUsage =
    !handler ||
    (!bareOk && ((indexed.hasChildren && args.length === 0) || args.length < requiredCount));
  if (showUsage) {
    await showReference(message, path);
    return;
  }

  const member =
    message.member ?? (await message.guild.members.fetch(message.author.id));
  const send = (body: string | EmbedBuilder) =>
    message.reply({
      ...(typeof body === "string" ? { content: body } : { embeds: [body] }),
      allowedMentions: { parse: [], repliedUser: false },
    });
  const ctx: Ctx = {
    client,
    message,
    guild: message.guild,
    member,
    indexed,
    path,
    args,
    raw,
    prefix: guildPrefix(message.guild.id),
    reply: send,
    ok: (t) => send(embed(t)),
    fail: (t) => send(embed(t)),
  };

  const label = getPermissionLabel(indexed.moduleId, indexed.entry.path);
  if (missingPermission(ctx, label)) {
    await ctx.fail(`You need the **${label}** permission to use this command.`);
    return;
  }

  try {
    await handler(ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      await showReference(message, path);
    } else if (error instanceof CommandError) {
      await ctx.fail(error.message);
    } else {
      logger.error({ err: error, path }, "Zenyth command failed");
      await ctx.fail("Something went wrong while running that command.");
    }
  }
}
