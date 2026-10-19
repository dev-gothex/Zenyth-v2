import { ChannelType, PermissionFlagsBits, type Client, type VoiceChannel } from "discord.js";
import { logger } from "../../../lib/logger";
import { guildData, save, userData } from "../../store";
import { parseChannel, parseInteger, parseMember, parseRole } from "../args";
import { CommandError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";
import { sendPanel } from "./interface";
import { VOICE_HANDLERS, ownChannel } from "./voice";

interface VM {
  category?: string;
  bitrate?: number;
  region?: string | null;
  role?: string;
  generators: Record<string, { size: number }>;
  channels: Record<string, string>;
  waiting?: Record<string, string>;
}

function vm(guildId: string): VM {
  const bag = guildData(guildId);
  bag.vm ??= { generators: {}, channels: {} } satisfies VM;
  return bag.vm as VM;
}
const owners = (guildId: string) => (guildData(guildId).voiceOwners ??= {}) as Record<string, string>;

async function makeGenerator(ctx: Ctx, size: number, label: string): Promise<void> {
  const cfg = vm(ctx.guild.id);
  const channel = await ctx.guild.channels.create({
    name: `Join to Create${label ? ` (${label})` : ""}`,
    type: ChannelType.GuildVoice,
    parent: cfg.category ?? null,
    userLimit: size,
  });
  cfg.generators[channel.id] = { size };
  save();
  await ctx.ok(`Created the generator ${channel}${size ? ` with a limit of ${size}` : ""}.`);
}

const reuse = (path: string): Handler => (ctx) => VOICE_HANDLERS[path](ctx);

export const VOICEMASTER_HANDLERS: Record<string, Handler> = {
  "voicemaster setup": async (ctx) => {
    const cfg = vm(ctx.guild.id);
    const category = await ctx.guild.channels.create({ name: "Voice Channels", type: ChannelType.GuildCategory });
    cfg.category = category.id;
    await makeGenerator(ctx, 0, "");
    const panel = await ctx.guild.channels.create({ name: "interface", type: ChannelType.GuildText, parent: category.id });
    await sendPanel(ctx.client, ctx.guild.id, panel as never);
    await ctx.ok(`Posted the interface panel in ${panel}.`);
  },
  "voicemaster category": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    if (ch?.type !== ChannelType.GuildCategory) throw new CommandError("That is not a category.");
    vm(ctx.guild.id).category = ch.id;
    save();
    await ctx.ok(`New voice channels will be created in **${ch.name}**.`);
  },
  "voicemaster defaultbitrate": async (ctx) => {
    const kbps = parseInteger(ctx.args[0]);
    if (!kbps || kbps < 8) throw new CommandError("Enter a bitrate in kbps, at least 8.");
    vm(ctx.guild.id).bitrate = Math.min(kbps * 1000, ctx.guild.maximumBitrate);
    save();
    await ctx.ok(`Default bitrate set to **${Math.round(vm(ctx.guild.id).bitrate! / 1000)}kbps**.`);
  },
  "voicemaster defaultregion": async (ctx) => {
    const region = ctx.args[0].toLowerCase();
    vm(ctx.guild.id).region = region === "auto" ? null : region;
    save();
    await ctx.ok(`Default region set to **${region}**.`);
  },
  "voicemaster defaultrole": async (ctx) => {
    const role = parseRole(ctx, ctx.args[0]);
    if (!role) throw new CommandError("I could not find that role.");
    vm(ctx.guild.id).role = role.id;
    save();
    await ctx.ok(`Members in a VoiceMaster channel will receive ${role}.`);
  },
  "voicemaster reset": async (ctx) => {
    delete guildData(ctx.guild.id).vm;
    save();
    await ctx.ok("Reset the VoiceMaster configuration.");
  },
  "voicemaster generator duo": (ctx) => makeGenerator(ctx, 2, "Duo"),
  "voicemaster generator trio": (ctx) => makeGenerator(ctx, 3, "Trio"),
  "voicemaster generator squad": async (ctx) => {
    const size = parseInteger(ctx.args[0]) ?? 4;
    if (size < 2 || size > 99) throw new CommandError("The size must be between 2 and 99.");
    await makeGenerator(ctx, size, `Squad ${size}`);
  },
  "voicemaster generator list": async (ctx) => {
    const lines = Object.entries(vm(ctx.guild.id).generators).map(([id, g]) => `<#${id}> - ${g.size || "no"} limit`);
    await ctx.reply(embed(lines.join("\n") || "No generators configured.", "Generators"));
  },
  "voicemaster generator remove": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    const cfg = vm(ctx.guild.id);
    if (!ch || !cfg.generators[ch.id]) throw new CommandError("That channel is not a generator.");
    delete cfg.generators[ch.id];
    save();
    await ctx.ok(`Removed the generator **${ch.name}**.`);
  },

  "voicemaster lock": reuse("voice lock"),
  "voicemaster unlock": reuse("voice unlock"),
  "voicemaster ghost": reuse("voice hide"),
  "voicemaster unghost": reuse("voice unhide"),
  "voicemaster limit": reuse("voice limit"),
  "voicemaster name": reuse("voice rename"),
  "voicemaster bitrate": async (ctx) => {
    const channel = ownChannel(ctx);
    const kbps = parseInteger(ctx.args[0]);
    if (!kbps || kbps < 8) throw new CommandError("Enter a bitrate in kbps, at least 8.");
    await channel.setBitrate(Math.min(kbps * 1000, ctx.guild.maximumBitrate));
    await ctx.ok(`Set the bitrate to **${kbps}kbps**.`);
  },
  "voicemaster permit": async (ctx) => {
    const channel = ownChannel(ctx);
    const target = (await parseMember(ctx, ctx.args[0])) ?? parseRole(ctx, ctx.args[0]);
    if (!target) throw new CommandError("I could not find that member or role.");
    await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true });
    await ctx.ok(`${target} can now join ${channel}.`);
  },
  "voicemaster reject": async (ctx) => {
    const channel = ownChannel(ctx);
    const member = await parseMember(ctx, ctx.args[0]);
    const target = member ?? parseRole(ctx, ctx.args[0]);
    if (!target) throw new CommandError("I could not find that member or role.");
    await channel.permissionOverwrites.edit(target.id, { Connect: false });
    if (member && member.voice.channelId === channel.id) await member.voice.disconnect("VoiceMaster reject").catch(() => undefined);
    await ctx.ok(`${target} can no longer join ${channel}.`);
  },
  "voicemaster transfer": async (ctx) => {
    const channel = ownChannel(ctx);
    const target = await parseMember(ctx, ctx.args[0]);
    if (!target || target.voice.channelId !== channel.id) throw new CommandError("That member must be in your voice channel.");
    owners(ctx.guild.id)[channel.id] = target.id;
    save();
    await ctx.ok(`${target} now owns ${channel}.`);
  },
  "voicemaster claim": async (ctx) => {
    const channel = ctx.member.voice.channel;
    if (!channel || !vm(ctx.guild.id).channels[channel.id]) throw new CommandError("Join a VoiceMaster channel first.");
    const ownerId = owners(ctx.guild.id)[channel.id];
    if (ownerId && channel.members.has(ownerId)) throw new CommandError("The owner is still in the channel.");
    owners(ctx.guild.id)[channel.id] = ctx.member.id;
    save();
    await ctx.ok(`You now own ${channel}.`);
  },
  "voicemaster configuration": async (ctx) => {
    const channel = ctx.member.voice.channel;
    if (!channel) throw new CommandError("Join a voice channel first.");
    const ownerId = owners(ctx.guild.id)[channel.id];
    await ctx.reply(
      embed(
        [`**Owner:** ${ownerId ? `<@${ownerId}>` : "None"}`, `**Limit:** ${channel.userLimit || "None"}`, `**Bitrate:** ${Math.round(channel.bitrate / 1000)}kbps`].join("\n"),
        channel.name,
      ),
    );
  },
};

export function startVoiceMaster(client: Client): void {
  client.on("voiceStateUpdate", (before, after) => {
    void (async () => {
      const cfg = guildData(after.guild.id).vm as VM | undefined;
      if (!cfg) return;
      const member = after.member;
      if (before.channelId && before.channelId !== after.channelId && cfg.channels[before.channelId]) {
        if (cfg.role && member) await member.roles.remove(cfg.role).catch(() => undefined);
        const old = before.channel;
        if (old && old.members.size === 0) {
          const waitId = cfg.waiting?.[old.id];
          if (waitId) {
            await after.guild.channels.cache.get(waitId)?.delete().catch(() => undefined);
            delete cfg.waiting![old.id];
          }
          delete cfg.channels[old.id];
          delete owners(after.guild.id)[old.id];
          save();
          await old.delete("VoiceMaster channel empty").catch(() => undefined);
        }
      }
      if (!after.channelId || after.channelId === before.channelId || !member) return;
      const generator = cfg.generators[after.channelId];
      if (generator) {
        const parent = after.channel?.parentId ?? cfg.category ?? null;
        const prefs = (userData(member.id).vmPrefs ?? { trusted: [], blocked: [] }) as { trusted: string[]; blocked: string[] };
        const channel = (await after.guild.channels.create({
          name: `${member.displayName}'s channel`.slice(0, 100),
          type: ChannelType.GuildVoice,
          parent,
          userLimit: generator.size,
          bitrate: cfg.bitrate,
          rtcRegion: cfg.region ?? undefined,
          permissionOverwrites: [
            { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
            ...prefs.trusted.filter((id) => id !== member.id).map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] })),
            ...prefs.blocked.filter((id) => id !== member.id).map((id) => ({ id, deny: [PermissionFlagsBits.Connect] })),
          ],
        })) as VoiceChannel;
        cfg.channels[channel.id] = member.id;
        owners(after.guild.id)[channel.id] = member.id;
        save();
        await member.voice.setChannel(channel).catch(() => undefined);
      }
      if (cfg.role && (generator || cfg.channels[after.channelId])) await member.roles.add(cfg.role).catch(() => undefined);
    })().catch((err: unknown) => logger.error({ err }, "VoiceMaster failed"));
  });
}
