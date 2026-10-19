import type { Guild, User } from "discord.js";

/** Replaces {user}, {user.mention}, {user.name}, {server}, {membercount}. */
export function renderTemplate(template: string, user: User, guild: Guild): string {
  return template
    .replaceAll("{user.mention}", `<@${user.id}>`)
    .replaceAll("{user.name}", user.username)
    .replaceAll("{user}", `<@${user.id}>`)
    .replaceAll("{server}", guild.name)
    .replaceAll("{membercount}", String(guild.memberCount));
}
