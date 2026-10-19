import rawCommandDetails from "./module-command-details.json";

export interface CommandReferenceParameter {
  name: string;
  required: boolean;
}

export interface CommandReferenceEntry {
  path: string;
  signature: string;
  description: string;
  depth: number;
  parameters: CommandReferenceParameter[];
}

export interface CommandReferenceGroup {
  rootName: string;
  entries: CommandReferenceEntry[];
}

export interface CommandReferenceSelection {
  moduleId: string;
  groupIndex: number;
  scopeIndex: number;
  page: number;
  sorted: boolean;
}

export type CommandReferenceAction = "page" | "sort";

export interface ParsedCommandReferenceInteraction {
  action: CommandReferenceAction;
  selection: CommandReferenceSelection;
}

const commandDetails = rawCommandDetails as Record<
  string,
  CommandReferenceGroup[]
>;

export function getCommandReferencePage(
  selection: CommandReferenceSelection,
):
  | {
      group: CommandReferenceGroup;
      scopeEntry: CommandReferenceEntry;
      entries: CommandReferenceEntry[];
      currentEntry: CommandReferenceEntry;
    }
  | undefined {
  const group = commandDetails[selection.moduleId]?.[selection.groupIndex];
  if (
    !group ||
    !Number.isInteger(selection.scopeIndex) ||
    !Number.isInteger(selection.page) ||
    selection.page < 0
  ) {
    return undefined;
  }

  const scopeEntry = group.entries[selection.scopeIndex];
  if (!scopeEntry) return undefined;
  const children = group.entries.filter(
    (entry, index) =>
      index !== selection.scopeIndex &&
      entry.depth === scopeEntry.depth + 1 &&
      entry.path.startsWith(`${scopeEntry.path} `),
  );
  const entries = selection.sorted
    ? [
        scopeEntry,
        ...children.sort((left, right) =>
          left.path.localeCompare(right.path, undefined, {
            sensitivity: "base",
          }),
        ),
      ]
    : [scopeEntry, ...children];
  const currentEntry = entries[selection.page];
  if (!currentEntry) return undefined;

  return { group, scopeEntry, entries, currentEntry };
}

export function findCommandReference(
  query: string,
): CommandReferenceSelection | undefined {
  const queryTokens = query
    .trim()
    .toLowerCase()
    .replace(/[`<>]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (queryTokens.length === 0) return undefined;
  if (queryTokens[0] === "van") queryTokens[0] = "vanity";

  let bestMatch: CommandReferenceSelection | undefined;
  let bestEntry: CommandReferenceEntry | undefined;
  let bestGroup: CommandReferenceGroup | undefined;
  let longestPath = 0;

  for (const [moduleId, groups] of Object.entries(commandDetails)) {
    groups.forEach((group, groupIndex) => {
      group.entries.forEach((entry, page) => {
        const pathTokens = entry.path.toLowerCase().split(/\s+/);
        if (
          pathTokens.length > longestPath &&
          pathTokens.length <= queryTokens.length &&
          pathTokens.every((token, index) => token === queryTokens[index])
        ) {
          longestPath = pathTokens.length;
          bestMatch = {
            moduleId,
            groupIndex,
            scopeIndex: page,
            page: 0,
            sorted: false,
          };
          bestEntry = entry;
          bestGroup = group;
        }
      });
    });
  }

  if (!bestMatch || !bestEntry || !bestGroup) return undefined;

  const matchedSelection = bestMatch;
  const matchedEntry = bestEntry;
  const matchedGroup = bestGroup;
  const entryIndex = matchedSelection.scopeIndex;
  const hasChildren = matchedGroup.entries.some(
    (entry, index) =>
      index !== entryIndex &&
      entry.depth === matchedEntry.depth + 1 &&
      entry.path.startsWith(`${matchedEntry.path} `),
  );
  if (hasChildren || matchedEntry.depth === 0) return matchedSelection;

  let parentIndex = -1;
  let parentPathLength = -1;
  matchedGroup.entries.forEach((entry, index) => {
    if (
      entry.depth === matchedEntry.depth - 1 &&
      matchedEntry.path.startsWith(`${entry.path} `) &&
      entry.path.length > parentPathLength
    ) {
      parentIndex = index;
      parentPathLength = entry.path.length;
    }
  });
  if (parentIndex < 0) return matchedSelection;

  const parent = matchedGroup.entries[parentIndex];
  const siblings = [
    parent,
    ...matchedGroup.entries.filter(
      (entry, index) =>
        index !== parentIndex &&
        entry.depth === parent.depth + 1 &&
        entry.path.startsWith(`${parent.path} `),
    ),
  ];
  const page = siblings.findIndex(
    (entry) => entry.path === matchedEntry.path,
  );
  if (page < 0) return matchedSelection;
  return { ...matchedSelection, scopeIndex: parentIndex, page };
}

export function createCommandReferenceCustomId(
  action: CommandReferenceAction,
  selection: CommandReferenceSelection,
): string {
  return `zenyth:ref:${action}:${selection.moduleId}:${selection.groupIndex}:${selection.scopeIndex}:${selection.page}:${selection.sorted ? 1 : 0}`;
}

export function parseCommandReferenceInteraction(
  customId: string,
): ParsedCommandReferenceInteraction | undefined {
  const match = customId.match(
    /^zenyth:ref:(page|sort):([a-z0-9]+):(\d+):(\d+):(\d+):([01])$/,
  );
  if (!match) return undefined;

  const selection: CommandReferenceSelection = {
    moduleId: match[2],
    groupIndex: Number(match[3]),
    scopeIndex: Number(match[4]),
    page: Number(match[5]),
    sorted: match[6] === "1",
  };
  if (!getCommandReferencePage(selection)) return undefined;

  return { action: match[1] as CommandReferenceAction, selection };
}
