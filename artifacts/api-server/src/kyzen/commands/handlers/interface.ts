import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type Client,
  type GuildMember,
  type Interaction,
  type VoiceChannel,
} from "discord.js";
import { logger } from "../../../lib/logger";
import { guildData, save, userData } from "../../store";
import { parseChannel } from "../args";
import { CommandError, type Handler } from "../types";
import { INTERFACE_IMAGE_BASE64 } from "./interface-image";

const ACCENT = 0xd73155;
const IMAGE_NAME = "interface-buttons.png";

/** Button order matches the reference image: 3 rows of 5. */
const LAYOUT: string[][] = [
  ["name", "limit", "privacy", "waiting", "chat"],
  ["trust", "untrust", "invite", "kick", "region"],
  ["block", "unblock", "claim", "transfer", "delete"],
];
const LABELS: Record<string, string> = {
  name: "Name", limit: "Limit", privacy: "Privacy", waiting: "Waiting Room", chat: "Chat",
  trust: "Trust", untrust: "Untrust", invite: "Invite", kick: "Kick", region: "Region",
  block: "Block", unblock: "Unblock", claim: "Claim", transfer: "Transfer", delete: "Delete",
};

const REGIONS: [string, string | null][] = [
  ["Automatic", null], ["US East", "us-east"], ["US West", "us-west"], ["US Central", "us-central"],
  ["US South", "us-south"], ["Europe", "rotterdam"], ["Brazil", "brazil"], ["India", "india"],
  ["Japan", "japan"], ["Singapore", "singapore"], ["Hong Kong", "hongkong"], ["Sydney", "sydney"],
  ["South Africa", "southafrica"], ["Russia", "russia"],
];

/* ---------- emoji lookup (application emojis, then any guild emoji) ---------- */
type EmojiRef = { id: string; name: string; animated: boolean };
let emojiCache: Map<string, EmojiRef> | undefined;

const normalise = (s: string) =>
  s.toLowerCase().replace(/^(vm|tv|tempvoice|voicemaster|voice|icon|emoji|btn|button)+/g, "").replace(/[^a-z0-9]/g, "");

async function loadEmojis(client: Client): Promise<Map<string, EmojiRef>> {
  if (emojiCache) return emojiCache;
  const all: EmojiRef[] = [];
  const app = await client.application?.emojis.fetch().catch(() => null);
  for (const e of app?.values() ?? []) if (e.id && e.name) all.push({ id: e.id, name: e.name, animated: Boolean(e.animated) });
  for (const e of client.emojis.cache.values()) if (e.id && e.name) all.push({ id: e.id, name: e.name, animated: Boolean(e.animated) });

  const found = new Map<string, EmojiRef>();
  for (const key of Object.keys(LABELS)) {
    const wanted = key === "waiting" ? ["waiting", "waitingroom", "wait"] : [key];
    const exact = all.find((e) => wanted.includes(normalise(e.name)));
    const loose = all.find((e) => {
      const n = normalise(e.name);
      return wanted.some((w) => n.includes(w)) && !((key === "trust" || key === "block") && n.includes("un"));
    });
    const hit = exact ?? loose;
    if (hit) found.set(key, hit);
  }
  if (found.size > 0) emojiCache = found; // retry next time if none were found yet
  return found;
}

/* ---------- panel ---------- */
export async function panelPayload(client: Client) {
  const emojis = await loadEmojis(client);
  const rows = LAYOUT.map((keys) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      keys.map((key) => {
        const button = new ButtonBuilder().setCustomId(`vmi:${key}`).setStyle(ButtonStyle.Secondary);
        const emoji = emojis.get(key);
        if (emoji) button.setEmoji({ id: emoji.id, name: emoji.name, animated: emoji.animated });
        else button.setLabel(LABELS[key]); // fallback when the emoji is not found
        return button;
      }),
    ),
  );
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle("TempVoice Interface")
    .setDescription("This **Interface** can be used to manage **Temporary** voice channels.\n> Press the buttons below to use the interface.")
    .setImage(`attachment://${IMAGE_NAME}`)
    .setFooter({ text: client.user?.username ?? "Zenyth", iconURL: client.user?.displayAvatarURL() });
  const file = new AttachmentBuilder(Buffer.from(INTERFACE_IMAGE_BASE64, "base64"), { name: IMAGE_NAME });
  return { embeds: [embed], components: rows, files: [file] };
}

interface Panel { channelId: string; messageId: string }
const vmCfg = (guildId: string) => (guildData(guildId).vm ??= { generators: {}, channels: {} }) as {
  generators: Record<string, { size: number }>;
  channels: Record<string, string>;
  panel?: Panel;
  waiting?: Record<string, string>;
};
const owners = (guildId: string) => (guildData(guildId).voiceOwners ??= {}) as Record<string, string>;
const prefs = (userId: string) => (userData(userId).vmPrefs ??= { trusted: [], blocked: [] }) as { trusted: string[]; blocked: string[] };

export async function sendPanel(client: Client, guildId: string, channel: { id: string; send: (o: never) => Promise<{ id: string }> }): Promise<void> {
  const message = await channel.send((await panelPayload(client)) as never);
  vmCfg(guildId).panel = { channelId: channel.id, messageId: message.id };
  save();
}

/* ---------- commands ---------- */
export const INTERFACE_HANDLERS: Record<string, Handler> = {
  "voicemaster interface send": async (ctx) => {
    const ch = ctx.args[0] ? parseChannel(ctx, ctx.args[0]) : ctx.message.channel;
    if (!ch?.isTextBased() || !("send" in ch)) throw new CommandError("I could not find that text channel.");
    await sendPanel(ctx.client, ctx.guild.id, ch as never);
    await ctx.ok(`Sent the interface to ${ch}.`);
  },
  "voicemaster interface move": async (ctx) => {
    const ch = parseChannel(ctx, ctx.args[0]);
    if (!ch?.isTextBased() || !("send" in ch)) throw new CommandError("I could not find that text channel.");
    const old = vmCfg(ctx.guild.id).panel;
    if (old) {
      const oldChannel = ctx.guild.channels.cache.get(old.channelId);
      if (oldChannel?.isTextBased()) await oldChannel.messages.delete(old.messageId).catch(() => undefined);
    }
    await sendPanel(ctx.client, ctx.guild.id, ch as never);
    await ctx.ok(`Moved the interface to ${ch}.`);
  },
  "voicemaster refresh": async (ctx) => {
    const panel = vmCfg(ctx.guild.id).panel;
    const channel = panel ? ctx.guild.channels.cache.get(panel.channelId) : undefined;
    if (!panel || !channel?.isTextBased()) throw new CommandError("No interface panel exists. Use `voicemaster interface send`.");
    const payload = await panelPayload(ctx.client);
    await channel.messages.edit(panel.messageId, { ...payload, attachments: [] }).catch(() => {
      throw new CommandError("I could not edit the panel. It may have been deleted.");
    });
    await ctx.ok("Refreshed the interface panel.");
  },
};

/* ---------- interactions ---------- */
async function reply(i: Interaction & { reply: Function }, content: string): Promise<void> {
  await i.reply({ content, flags: MessageFlags.Ephemeral });
}

function owned(i: Interaction, requireOwner = true): { member: GuildMember; channel: VoiceChannel } | string {
  const member = i.member as GuildMember;
  const channel = member.voice.channel as VoiceChannel | null;
  if (!channel) return "Join your voice channel first.";
  const cfg = vmCfg(i.guildId!);
  if (!cfg.channels[channel.id]) return "This is not a temporary voice channel.";
  if (requireOwner && owners(i.guildId!)[channel.id] !== member.id) return "You do not own this voice channel.";
  return { member, channel };
}

function userPicker(action: string, text: string) {
  return {
    content: text,
    flags: MessageFlags.Ephemeral as const,
    components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId(`vmi:sel:${action}`).setPlaceholder("Choose a member").setMinValues(1).setMaxValues(1))],
  };
}

async function toggleWaiting(channel: VoiceChannel, owner: GuildMember): Promise<string> {
  const cfg = vmCfg(channel.guild.id);
  cfg.waiting ??= {};
  const existing = cfg.waiting[channel.id];
  if (existing) {
    await channel.guild.channels.cache.get(existing)?.delete("Waiting room off").catch(() => undefined);
    delete cfg.waiting[channel.id];
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { Connect: null });
    save();
    return "The waiting room is off.";
  }
  await channel.permissionOverwrites.edit(owner, { Connect: true, ViewChannel: true });
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { Connect: false });
  const waiting = await channel.guild.channels.create({
    name: `Waiting - ${channel.name}`.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: channel.parentId,
    permissionOverwrites: [{ id: channel.guild.roles.everyone.id, deny: ["Speak"] }],
  });
  cfg.waiting[channel.id] = waiting.id;
  save();
  return `The waiting room is on. Members who join ${waiting} need your approval.`;
}

async function onUserSelect(i: Interaction & { isUserSelectMenu(): true }): Promise<void> {
  const action = (i as never as { customId: string }).customId.split(":")[2];
  const state = owned(i);
  if (typeof state === "string") return void (await reply(i as never, state));
  const { member, channel } = state;
  const targetId = (i as never as { values: string[] }).values[0];
  const target = await channel.guild.members.fetch(targetId).catch(() => null);
  if (!target || target.id === member.id) return void (await (i as never as { update: Function }).update({ content: "Pick someone other than yourself.", components: [] }));
  const mine = prefs(member.id);
  let text = "";
  switch (action) {
    case "trust":
      if (!mine.trusted.includes(target.id)) mine.trusted.push(target.id);
      await channel.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true });
      text = `${target} is now trusted and can always join your channels.`;
      break;
    case "untrust":
      mine.trusted = mine.trusted.filter((x) => x !== target.id);
      await channel.permissionOverwrites.delete(target.id).catch(() => undefined);
      text = `${target} is no longer trusted.`;
      break;
    case "block":
      mine.blocked = [...new Set([...mine.blocked, target.id])];
      await channel.permissionOverwrites.edit(target, { Connect: false });
      if (target.voice.channelId === channel.id) await target.voice.disconnect("Blocked").catch(() => undefined);
      text = `${target} is blocked from your channels.`;
      break;
    case "unblock":
      mine.blocked = mine.blocked.filter((x) => x !== target.id);
      await channel.permissionOverwrites.delete(target.id).catch(() => undefined);
      text = `${target} is unblocked.`;
      break;
    case "invite": {
      await channel.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true });
      const invite = await channel.createInvite({ maxAge: 3600, maxUses: 1 }).catch(() => null);
      const sent = invite ? await target.send(`${member.user.tag} invited you to join **${channel.name}**: ${invite.url}`).then(() => true).catch(() => false) : false;
      text = sent ? `Invited ${target}.` : `${target} can join now, but I could not DM them.`;
      break;
    }
    case "kick":
      if (target.voice.channelId !== channel.id) { text = `${target} is not in your channel.`; break; }
      await target.voice.disconnect("Kicked by channel owner").catch(() => undefined);
      text = `Kicked ${target}.`;
      break;
    case "transfer":
      if (target.voice.channelId !== channel.id) { text = `${target} must be in your channel.`; break; }
      owners(channel.guild.id)[channel.id] = target.id;
      vmCfg(channel.guild.id).channels[channel.id] = target.id;
      text = `${target} now owns this channel.`;
      break;
    default:
      text = "Unknown action.";
  }
  save();
  await (i as never as { update: Function }).update({ content: text, components: [] });
}

async function handle(i: Interaction): Promise<void> {
  if (!i.inGuild() || !i.guildId) return;

  if (i.isButton() && i.customId.startsWith("vmi:wait:")) {
    const [, , verdict, userId, mainId] = i.customId.split(":");
    const main = i.guild?.channels.cache.get(mainId) as VoiceChannel | undefined;
    if (!main || owners(i.guildId)[mainId] !== i.user.id) return void (await reply(i, "Only the channel owner can answer this."));
    const waitingId = vmCfg(i.guildId).waiting?.[mainId];
    const target = await i.guild!.members.fetch(userId).catch(() => null);
    if (target && verdict === "accept") {
      await main.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true });
      if (target.voice.channelId === waitingId) await target.voice.setChannel(main).catch(() => undefined);
    } else if (target && target.voice.channelId === waitingId) {
      await target.voice.disconnect("Declined from waiting room").catch(() => undefined);
    }
    await i.update({ content: `${verdict === "accept" ? "Accepted" : "Declined"} <@${userId}>.`, components: [] });
    return;
  }

  if (i.isUserSelectMenu() && i.customId.startsWith("vmi:sel:")) return onUserSelect(i as never);

  if (i.isStringSelectMenu() && i.customId.startsWith("vmi:sel:")) {
    const state = owned(i);
    if (typeof state === "string") return void (await reply(i, state));
    const { channel } = state;
    const action = i.customId.split(":")[2];
    const value = i.values[0];
    let text = "";
    if (action === "region") {
      await channel.setRTCRegion(value === "auto" ? null : value);
      text = `Region set to **${REGIONS.find(([, v]) => (v ?? "auto") === value)?.[0] ?? value}**.`;
    } else if (action === "privacy") {
      const everyone = channel.guild.roles.everyone;
      const edits: Record<string, Record<string, boolean | null>> = {
        lock: { Connect: false }, unlock: { Connect: null }, ghost: { ViewChannel: false }, unghost: { ViewChannel: null },
      };
      await channel.permissionOverwrites.edit(state.member, { Connect: true, ViewChannel: true });
      await channel.permissionOverwrites.edit(everyone, edits[value]);
      text = { lock: "Locked your channel.", unlock: "Unlocked your channel.", ghost: "Hid your channel.", unghost: "Your channel is visible again." }[value] ?? "Done.";
    }
    await i.update({ content: text, components: [] });
    return;
  }

  if (i.isModalSubmit() && i.customId.startsWith("vmi:modal:")) {
    const state = owned(i);
    if (typeof state === "string") return void (await reply(i, state));
    const { channel } = state;
    const value = i.fields.getTextInputValue("value").trim();
    if (i.customId.endsWith(":name")) {
      await channel.setName(value.slice(0, 100));
      await reply(i, `Renamed the channel to **${value.slice(0, 100)}**.`);
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 99) return void (await reply(i, "Enter a whole number from 0 to 99 (0 removes the limit)."));
      await channel.setUserLimit(n);
      await reply(i, n === 0 ? "Removed the user limit." : `Set the user limit to **${n}**.`);
    }
    return;
  }

  if (!i.isButton() || !i.customId.startsWith("vmi:")) return;
  const action = i.customId.split(":")[1];

  if (action === "claim") {
    const state = owned(i, false);
    if (typeof state === "string") return void (await reply(i, state));
    const ownerId = owners(i.guildId)[state.channel.id];
    if (ownerId === state.member.id) return void (await reply(i, "You already own this channel."));
    if (ownerId && state.channel.members.has(ownerId)) return void (await reply(i, "The owner is still in the channel."));
    owners(i.guildId)[state.channel.id] = state.member.id;
    vmCfg(i.guildId).channels[state.channel.id] = state.member.id;
    save();
    return void (await reply(i, `You now own ${state.channel}.`));
  }

  const state = owned(i);
  if (typeof state === "string") return void (await reply(i, state));
  const { member, channel } = state;

  switch (action) {
    case "name":
    case "limit": {
      const modal = new ModalBuilder().setCustomId(`vmi:modal:${action}`).setTitle(action === "name" ? "Rename channel" : "User limit").addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("value").setLabel(action === "name" ? "New name" : "Limit (0 = none)").setStyle(TextInputStyle.Short).setMaxLength(action === "name" ? 100 : 2).setRequired(true),
        ),
      );
      return void (await i.showModal(modal));
    }
    case "privacy":
      return void (await i.reply({
        content: "Choose a privacy setting.",
        flags: MessageFlags.Ephemeral,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder().setCustomId("vmi:sel:privacy").setPlaceholder("Privacy").addOptions(
            { label: "Lock", value: "lock", description: "Nobody new can join" },
            { label: "Unlock", value: "unlock" },
            { label: "Ghost", value: "ghost", description: "Hide the channel" },
            { label: "Unghost", value: "unghost" },
          ),
        )],
      }));
    case "region":
      return void (await i.reply({
        content: "Choose a voice region.",
        flags: MessageFlags.Ephemeral,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder().setCustomId("vmi:sel:region").setPlaceholder("Region").addOptions(REGIONS.map(([label, value]) => ({ label, value: value ?? "auto" }))),
        )],
      }));
    case "waiting":
      return void (await reply(i, await toggleWaiting(channel, member)));
    case "chat": {
      const everyone = channel.guild.roles.everyone;
      const locked = channel.permissionOverwrites.cache.get(everyone.id)?.deny.has("SendMessages") ?? false;
      await channel.permissionOverwrites.edit(everyone, { SendMessages: locked ? null : false });
      return void (await reply(i, locked ? "Unlocked the channel chat." : "Locked the channel chat."));
    }
    case "trust": return void (await i.reply(userPicker("trust", "Choose a member to trust.")));
    case "untrust": return void (await i.reply(userPicker("untrust", "Choose a member to untrust.")));
    case "invite": return void (await i.reply(userPicker("invite", "Choose a member to invite.")));
    case "kick": return void (await i.reply(userPicker("kick", "Choose a member to kick.")));
    case "block": return void (await i.reply(userPicker("block", "Choose a member to block.")));
    case "unblock": return void (await i.reply(userPicker("unblock", "Choose a member to unblock.")));
    case "transfer": return void (await i.reply(userPicker("transfer", "Choose the new owner.")));
    case "delete": {
      const waitingId = vmCfg(channel.guild.id).waiting?.[channel.id];
      await reply(i, "Deleting your channel.");
      if (waitingId) await channel.guild.channels.cache.get(waitingId)?.delete().catch(() => undefined);
      delete vmCfg(channel.guild.id).channels[channel.id];
      delete owners(channel.guild.id)[channel.id];
      save();
      await channel.delete("Deleted by owner").catch(() => undefined);
    }
  }
}

export function startInterface(client: Client): void {
  client.on(Events.InteractionCreate, (i) => {
    void handle(i).catch((err: unknown) => {
      logger.error({ err }, "VoiceMaster interface failed");
      if (i.isRepliable() && !i.replied && !i.deferred) void i.reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    });
  });

  // Waiting room: ask the owner when someone joins.
  client.on("voiceStateUpdate", (before, after) => {
    if (!after.channelId || after.channelId === before.channelId || !after.member) return;
    const cfg = vmCfg(after.guild.id);
    const mainId = Object.entries(cfg.waiting ?? {}).find(([, waitId]) => waitId === after.channelId)?.[0];
    const main = mainId ? (after.guild.channels.cache.get(mainId) as VoiceChannel | undefined) : undefined;
    const ownerId = mainId ? owners(after.guild.id)[mainId] : undefined;
    if (!main || !mainId || !ownerId) return;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`vmi:wait:accept:${after.id}:${mainId}`).setLabel("Accept").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vmi:wait:deny:${after.id}:${mainId}`).setLabel("Decline").setStyle(ButtonStyle.Danger),
    );
    void main.send({ content: `<@${ownerId}>, ${after.member} is waiting to join.`, components: [row], allowedMentions: { users: [ownerId] } }).catch(() => undefined);
  });
}
