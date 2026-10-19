import rawCommandCatalog from "./command-catalog.json";

export type CommandGroup = "moderation" | "other";

export interface CommandDefinition {
  category: CommandGroup;
  depth: number;
  name: string;
  description: string;
}

const catalog = rawCommandCatalog as {
  commandCount: number;
  moderationCount: number;
  uncategorizedCount: number;
  commands: CommandDefinition[];
};

export const COMMAND_CATALOG = catalog.commands;
export const COMMAND_CATALOG_COUNT = catalog.commandCount;
export const MODERATION_COMMAND_COUNT = catalog.moderationCount;
export const UNCATEGORIZED_COMMAND_COUNT = catalog.uncategorizedCount;

export function getCommandsForGroup(group: CommandGroup): CommandDefinition[] {
  return COMMAND_CATALOG.filter((command) => command.category === group);
}
