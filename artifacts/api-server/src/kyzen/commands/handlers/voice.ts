import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import { guildData, save } from "../../store";
import { formatDuration, parseDuration, parseInteger, parseMember, parseUser } from "../args";
import { CommandError, UsageError, type Ctx, type Handler } from "../types";
import { embed } from "../ui";

function voiceOf(member: GuildMember): VoiceBasedChannel | null {
  return member.voice.channel;
}

/** The caller's current voice channel, if they may manage it. */
function ownChannel(ctx: Ctx): VoiceBasedChannel {
  const channel = voiceOf(ctx.member);
  if (!channel) throw new CommandError("Join a voice channel first.");
  const owners = (guildData(ctx.guild.id).voiceOwners ??= {}) as Record<string, string>;
  const isMod = ctx.member.permissions.has(PermissionFlagsBits.ManageChannels);
  const humans = channel.members.filter((m) => !m.user.bot);
  if (!owners[channel.id] && humans.size === 1 && humans.has(ctx.member.id)) {
    owners[channel.id] = ctx.member.id;
    save();
  }
  if (!isMod && owners[channel.id] !== ctx.member.id) {
    throw new CommandError("You do not own this voice channel.");
  }
  return channel;
}

async function channelTarget(ctx: Ctx, channel: VoiceBasedChannel): Promise<GuildMember> {
  const target = await parseMember(ctx, ctx.args[0]);
  if (!target) throw new CommandError("I could not find that member.");
  if (voiceOf(target)?.id !== channel.id) {
    throw new CommandError(`${target.displayName} is not in your voice channel.`);
  }
  return target;
}

const others = (ctx: Ctx, channel: VoiceBasedChannel) =>
  [...channel.members.values()].filter((m) => m.id !== ctx.member.id && !m.user.bot);

const reasonFrom = (ctx: Ctx, from: number) =>
  `${ctx.args.slice(from).join(" ") || "No reason provided"} (by ${ctx.member.user.tag})`;

function single(
  verb: string,
  action: (target: GuildMember, reason: string) => Promise<unknown>,
  done: string,
): Handler {
  return async (ctx) => {
    const channel = voiceOf(ctx.member);
    if (!channel) throw new CommandError("Join a voice channel first.");
    const target = await channelTarget(ctx, channel);
    await action(target, reasonFrom(ctx, 1)).catch(() => {
      throw new CommandError(`I could not ${verb} ${target.displayName}.`);
    });
    await ctx.ok(`${done} **${target.displayName}**.`);
  };
}

function everyone(
  action: (m: GuildMember, reason: string) => Promise<unknown>,
  done: string,
): Handler {
  return async (ctx) => {
    const channel = voiceOf(ctx.member);
    if (!channel) throw new CommandError("Join a voice channel first.");
    const targets = others(ctx, channel);
    const results = await Promise.allSettled(targets.map((m) => action(m, reasonFrom(ctx, 0))));
    const count = results.filter((r) => r.status === "fulfilled").length;
    await ctx.ok(`${done} **${count}** member${count === 1 ? "" : "s"}.`);
  };
}

const muteTimers = new Map<string, NodeJS.Timeout>();

export const VOICE_HANDLERS: Record<string, Handler> = {
  "voice deafen": single("deafen", (m, r) => m.voice.setDeaf(true, r), "Deafened"),
  "voice undeafen": single("undeafen", (m, r) => m.voice.setDeaf(false, r), "Undeafened"),
  "voice deafenall": everyone((m, r) => m.voice.setDeaf(true, r), "Deafened"),
  "voice undeafenall": everyone((m, r) => m.voice.setDeaf(false, r), "Undeafened"),
  "voice muteall": everyone((m, r) => m.voice.setMute(true, r), "Muted"),
  "voice unmuteall": everyone((m, r) => m.voice.setMute(false, r), "Unmuted"),
  "voice kickall": everyone((m, r) => m.voice.disconnect(r), "Disconnected"),
  "voice kick": single("kick", (m, r) => m.voice.disconnect(r), "Disconnected"),
  "voice unmute": single("unmute", (m, r) => m.voice.setMute(false, r), "Unmuted"),

  "voice mute": async (ctx) => {
    const channel = voiceOf(ctx.member);
    if (!channel) throw new CommandError("Join a voice channel first.");
    const target = await channelTarget(ctx, channel);
    const duration = parseDuration(ctx.args[1]);
    const reason = reasonFrom(ctx, duration ? 2 : 1);
    await target.voice.setMute(true, reason).catch(() => {
      throw new CommandError(`I could not mute ${target.displayName}.`);
    });
    const key = `${ctx.guild.id}:${target.id}`;
    clearTimeout(muteTimers.get(key));
    if (duration) {
      muteTimers.set(
        key,
        setTimeout(() => {
          muteTimers.delete(key);
          void target.voice.setMute(false, "Timed mute expired").catch(() => undefined);
        }, duration),
      );
    }
    await ctx.ok(
      `Muted **${target.displayName}**${duration ? ` for ${formatDuration(duration)}` : ""}.`,
    );
  },

  "voice lock": async (ctx) => {
    const channel = ownChannel(ctx);
    await channel.permissionOverwrites.edit(ctx.member, { Connect: true });
    await channel.permissionOverwrites.edit(ctx.guild.roles.everyone, { Connect: false });
    await ctx.ok(`Locked ${channel}.`);
  },
  "voice unlock": async (ctx) => {
    const channel = ownChannel(ctx);
    await channel.permissionOverwrites.edit(ctx.guild.roles.everyone, { Connect: null });
    await ctx.ok(`Unlocked ${channel}.`);
  },
  "voice hide": async (ctx) => {
    const channel = ownChannel(ctx);
    await channel.permissionOverwrites.edit(ctx.member, { ViewChannel: true });
    await channel.permissionOverwrites.edit(ctx.guild.roles.everyone, { ViewChannel: false });
    await ctx.ok(`Hid ${channel}.`);
  },
  "voice unhide": async (ctx) => {
    const channel = ownChannel(ctx);
    await channel.permissionOverwrites.edit(ctx.guild.roles.everyone, { ViewChannel: null });
    await ctx.ok(`${channel} is visible again.`);
  },
  "voice limit": async (ctx) => {
    const channel = ownChannel(ctx);
    const limit = parseInteger(ctx.args[0]);
    if (limit === null || limit < 0 || limit > 99) {
      throw new CommandError("The limit must be a number from 0 to 99 (0 removes it).");
    }
    await channel.setUserLimit(limit);
    await ctx.ok(limit === 0 ? "Removed the user limit." : `Set the user limit to **${limit}**.`);
  },
  "voice rename": async (ctx) => {
    const channel = ownChannel(ctx);
    const name = ctx.raw.slice(0, 100);
    if (!name) throw new UsageError();
    await channel.setName(name);
    await ctx.ok(`Renamed the channel to **${name}**.`);
  },
  "voice status": async (ctx) => {
    const channel = ownChannel(ctx);
    const status = ctx.raw.slice(0, 500);
    if (!status) throw new UsageError();
    await ctx.client.rest
      .put(`/channels/${channel.id}/voice-status`, { body: { status } })
      .catch(() => {
        throw new CommandError("I could not set the voice channel status.");
      });
    await ctx.ok("Updated the voice channel status.");
  },
  "voice nickall": async (ctx) => {
    const channel = ownChannel(ctx);
    const nick = ctx.raw.slice(0, 32);
    const results = await Promise.allSettled(
      [...channel.members.values()]
        .filter((m) => m.manageable)
        .map((m) => m.setNickname(nick, `Voice nickall by ${ctx.member.user.tag}`)),
    );
    const count = results.filter((r) => r.status === "fulfilled").length;
    await ctx.ok(`Changed the nickname of **${count}** member${count === 1 ? "" : "s"}.`);
  },
  "voice list": async (ctx) => {
    const channel = voiceOf(ctx.member);
    if (!channel) throw new CommandError("Join a voice channel first.");
    const lines = [...channel.members.values()].map((m) => `${m} (${m.user.tag})`);
    await ctx.reply(embed(lines.join("\n") || "Nobody is here.", `Members in ${channel.name} (${lines.length})`));
  },
  "voice invite": async (ctx) => {
    const channel = ownChannel(ctx);
    const target = await parseMember(ctx, ctx.args[0]);
    if (!target) throw new CommandError("I could not find that member.");
    await channel.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true });
    const invite = await channel.createInvite({ maxAge: 3600, maxUses: 1 }).catch(() => null);
    const dm = invite
      ? await target
          .send(`${ctx.member.user.tag} invited you to join **${channel.name}**: ${invite.url}`)
          .then(() => true)
          .catch(() => false)
      : false;
    await ctx.ok(
      dm
        ? `Invited **${target.displayName}** to ${channel}.`
        : `Gave **${target.displayName}** access to ${channel}, but I could not DM them.`,
    );
  },
  "voice pull": async (ctx) => {
    const channel = voiceOf(ctx.member);
    if (!channel) throw new CommandError("Join a voice channel first.");
    const target = await parseMember(ctx, ctx.args[0]);
    if (!target) throw new CommandError("I could not find that member.");
    if (!voiceOf(target)) throw new CommandError(`${target.displayName} is not in a voice channel.`);
    await target.voice.setChannel(channel, `Pulled by ${ctx.member.user.tag}`).catch(() => {
      throw new CommandError(`I could not move ${target.displayName}.`);
    });
    await ctx.ok(`Pulled **${target.displayName}** into ${channel}.`);
  },
  "voice request": async (ctx) => {
    const requester = ctx.member;
    const target = await parseUser(ctx, ctx.args[0]).then((u) =>
      u ? ctx.guild.members.fetch(u.id).catch(() => null) : null,
    );
    const destination = target ? voiceOf(target) : null;
    if (!target || !destination) {
      throw new CommandError("That member is not in a voice channel.");
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vr:yes").setLabel("Accept").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("vr:no").setLabel("Decline").setStyle(ButtonStyle.Danger),
    );
    const prompt = await ctx.message.reply({
      content: `${target}, ${requester} wants to join ${destination}.`,
      components: [row],
      allowedMentions: { users: [target.id], repliedUser: false },
    });
    const collector = prompt.createMessageComponentCollector({
      filter: (i) => i.user.id === target.id,
      time: 60_000,
      max: 1,
    });
    collector.on("collect", async (i) => {
      if (i.customId === "vr:yes") {
        await destination.permissionOverwrites
          .edit(requester, { ViewChannel: true, Connect: true })
          .catch(() => undefined);
        const moved = requester.voice.channel
          ? await requester.voice.setChannel(destination).then(() => true).catch(() => false)
          : false;
        await i.update({
          content: moved
            ? `${requester.displayName} joined ${destination}.`
            : `${requester.displayName} can now join ${destination}.`,
          components: [],
        });
      } else {
        await i.update({ content: `${target.displayName} declined the request.`, components: [] });
      }
    });
    collector.on("end", (collected) => {
      if (collected.size === 0) {
        void prompt.edit({ content: "The request expired.", components: [] }).catch(() => undefined);
      }
    });
  },
};
