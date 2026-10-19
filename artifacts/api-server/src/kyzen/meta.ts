import { PermissionFlagsBits } from "discord.js";

/** Display names used in help + enforced before a command runs. */
export const PERMISSION_BITS: Record<string, bigint | undefined> = {
  "Standard Access": undefined,
  Administrator: PermissionFlagsBits.Administrator,
  "Manage Guild": PermissionFlagsBits.ManageGuild,
  "Manage Channels": PermissionFlagsBits.ManageChannels,
  "Manage Messages": PermissionFlagsBits.ManageMessages,
  "Manage Nicknames": PermissionFlagsBits.ManageNicknames,
  "Manage Roles": PermissionFlagsBits.ManageRoles,
  "Ban Members": PermissionFlagsBits.BanMembers,
  "Kick Members": PermissionFlagsBits.KickMembers,
  "Moderate Members": PermissionFlagsBits.ModerateMembers,
  "Deafen Members": PermissionFlagsBits.DeafenMembers,
  "Mute Members": PermissionFlagsBits.MuteMembers,
  "Move Members": PermissionFlagsBits.MoveMembers,
};

const ROOT_ALIASES: Record<string, string> = {
  van: "vanity",
  vc: "voice",
  bal: "balance",
  lb: "leaderboard",
};

const MODERATION_ROOT_PERMISSIONS: Record<string, string> = {
  ban: "Ban Members",
  softban: "Ban Members",
  tempban: "Ban Members",
  hardban: "Ban Members",
  unban: "Ban Members",
  kick: "Kick Members",
  timeout: "Moderate Members",
  untimeout: "Moderate Members",
  warn: "Moderate Members",
  silence: "Moderate Members",
  unsilence: "Moderate Members",
  purge: "Manage Messages",
  pin: "Manage Messages",
  unpin: "Manage Messages",
  snipe: "Manage Messages",
  clearsnipes: "Manage Messages",
  slowmode: "Manage Channels",
  lockdown: "Manage Channels",
  unlockdown: "Manage Channels",
  hide: "Manage Channels",
  nuke: "Manage Channels",
  topic: "Manage Channels",
  nickname: "Manage Nicknames",
  forcenickname: "Manage Nicknames",
  role: "Manage Roles",
  strip: "Manage Roles",
};

const VOICE_SUB_PERMISSIONS: Record<string, string> = {
  deafen: "Deafen Members",
  deafenall: "Deafen Members",
  undeafen: "Deafen Members",
  undeafenall: "Deafen Members",
  mute: "Mute Members",
  muteall: "Mute Members",
  unmute: "Mute Members",
  unmuteall: "Mute Members",
  kick: "Move Members",
  kickall: "Move Members",
  pull: "Move Members",
  nickall: "Manage Nicknames",
};

const USER_LEVEL_ROOTS = new Set([
  "afk",
  "boosts",
  "channelinfo",
  "roleinfo",
  "serverinfo",
  "serveravatar",
  "servericon",
  "serverbanner",
  "joinposition",
  "recentjoins",
  "poll",
  "quickpoll",
  "suggest",
  "tag",
  "timezone",
  "translate",
]);

export function getPermissionLabel(moduleId: string, path: string): string {
  const [root, sub] = path.toLowerCase().split(/\s+/);
  if (moduleId === "moderation") {
    if (root === "voice") return sub ? (VOICE_SUB_PERMISSIONS[sub] ?? "Standard Access") : "Standard Access";
    return MODERATION_ROOT_PERMISSIONS[root] ?? "Manage Guild";
  }
  if (moduleId === "security") return "Administrator";
  if (
    ["config", "voicemaster", "feeds", "reposter", "track", "confessions", "esports", "statistics", "socials"].includes(moduleId)
  ) {
    return USER_LEVEL_ROOTS.has(root) && moduleId === "config" ? "Standard Access" : "Manage Guild";
  }
  return "Standard Access";
}

/** Aliases for a command path. Generic: disable -> off, enable -> on. */
export function getAliases(path: string): string[] {
  const parts = path.toLowerCase().split(/\s+/);
  const last = parts[parts.length - 1];
  if (parts.length === 1) {
    return Object.entries(ROOT_ALIASES)
      .filter(([, target]) => target === last)
      .map(([alias]) => alias);
  }
  if (last === "disable") return ["off"];
  if (last === "enable") return ["on"];
  return [];
}

export function resolveRootAlias(token: string): string {
  return ROOT_ALIASES[token] ?? token;
}

export function resolveSubAlias(token: string): string {
  if (token === "off") return "disable";
  if (token === "on") return "enable";
  return token;
}
