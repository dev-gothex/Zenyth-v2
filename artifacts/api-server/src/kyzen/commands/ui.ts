import { EmbedBuilder } from "discord.js";

export const WHITE = 0xffffff;

export function embed(description: string, title?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(WHITE).setDescription(description);
  if (title) e.setTitle(title);
  return e;
}
