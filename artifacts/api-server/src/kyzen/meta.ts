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
  "View Audit Log": PermissionFlagsBits.ViewAuditLog,
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
  jail: "Moderate Members",
  unjail: "Moderate Members",
  chatban: "Moderate Members",
  vcban: "Moderate Members",
  modcases: "Moderate Members",
  modstats: "Moderate Members",
  history: "Moderate Members",
  scan: "Moderate Members",
  audit: "View Audit Log",
  editsnipe: "Manage Messages",
  reactionsnipe: "Manage Messages",
  autosnipe: "Manage Guild",
  autopurge: "Manage Guild",
  cleanup: "Manage Messages",
  reveal: "Manage Channels",
  nsfw: "Manage Channels",
  picperms: "Manage Channels",
  thread: "Manage Channels",
  moveall: "Move Members",
  drag: "Move Members",
  emoji: "Manage Guild",
  sticker: "Manage Guild",
  newusers: "Moderate Members",
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

/** Exact command paths anyone may run, whatever their module's default is. */
const USER_LEVEL_PATHS = new Set([
  "afk", "boosts", "channelinfo", "roleinfo", "serverinfo", "serveravatar", "servericon",
  "serverbanner", "joinposition", "recentjoins", "poll", "quickpoll", "suggest", "translate",
  "timezone", "timezone set", "timezone remove",
  "level", "level leaderboard", "birthday", "birthday set",
  "prefix", "prefix self", "prefix self set", "prefix self reset",
]);
/** Roots that live in modules without an admin default but need Manage Guild. */
const ADMIN_ROOTS = new Set(["giveaway", "starboard", "birthday", "level"]);


export function getPermissionLabel(moduleId: string, path: string): string {
  const [root, sub] = path.toLowerCase().split(/\s+/);
  if (USER_LEVEL_PATHS.has(path.toLowerCase())) return "Standard Access";
  if (ADMIN_ROOTS.has(root)) return "Manage Guild";
  if (moduleId === "moderation") {
    if (root === "voice") return sub ? (VOICE_SUB_PERMISSIONS[sub] ?? "Standard Access") : "Standard Access";
    return MODERATION_ROOT_PERMISSIONS[root] ?? "Manage Guild";
  }
  if (moduleId === "security") return "Administrator";
  if (moduleId === "voicemaster") {
    const admin = ["setup", "category", "defaultbitrate", "defaultregion", "defaultrole", "generator", "interface", "refresh", "reset"];
    return admin.includes(sub ?? "") ? "Manage Guild" : "Standard Access";
  }
  if (moduleId === "track") {
    return ["avatarhistory", "avh", "checkvanity", "namehistory", "stalk"].includes(root) ? "Standard Access" : "Manage Guild";
  }
  if (
    ["config", "voicemaster", "feeds", "reposter", "track", "confessions", "esports", "statistics", "socials"].includes(moduleId)
  ) {
    return "Manage Guild";
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
