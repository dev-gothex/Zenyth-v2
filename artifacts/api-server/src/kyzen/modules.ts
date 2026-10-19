export interface ZenythModule {
  id: string;
  name: string;
  commandCount: number;
  description: string;
}

export const ZENYTH_MODULES: ZenythModule[] = [
  {
    id: "confessions",
    name: "Confessions",
    commandCount: 12,
    description: "Anonymous confessions system.",
  },
  {
    id: "config",
    name: "Config",
    commandCount: 768,
    description: "Configure Zenyth for your server.",
  },
  {
    id: "donor",
    name: "Donor",
    commandCount: 35,
    description: "Perks for supporting members.",
  },
  {
    id: "economy",
    name: "Economy",
    commandCount: 196,
    description: "Earn, spend and gamble with the server economy.",
  },
  {
    id: "esports",
    name: "Esports",
    commandCount: 35,
    description: "Esports management with automated scrim and tournament registration.",
  },
  {
    id: "family",
    name: "Family",
    commandCount: 15,
    description: "Marriage and family relationships.",
  },
  {
    id: "feeds",
    name: "Feeds",
    commandCount: 26,
    description: "Social feed notifications for YouTube, Twitch, Reddit, TikTok, and Instagram.",
  },
  {
    id: "fun",
    name: "Fun",
    commandCount: 37,
    description: "Fun commands for entertainment.",
  },
  {
    id: "lastfm",
    name: "LastFM",
    commandCount: 42,
    description: "Track your Last.fm listening.",
  },
  {
    id: "manipulation",
    name: "Manipulation",
    commandCount: 124,
    description: "Edit and generate images.",
  },
  {
    id: "minecraft",
    name: "Minecraft",
    commandCount: 40,
    description: "Connect Discord to your Minecraft servers.",
  },
  {
    id: "miscellaneous",
    name: "Miscellaneous",
    commandCount: 194,
    description: "General-purpose utilities.",
  },
  {
    id: "moderation",
    name: "Moderation",
    commandCount: 267,
    description: "Moderate members and manage the server.",
  },
  {
    id: "music",
    name: "Music",
    commandCount: 47,
    description: "Play music in voice channels.",
  },
  {
    id: "recording",
    name: "Recording",
    commandCount: 5,
    description: "Record audio from voice channels.",
  },
  {
    id: "reposter",
    name: "Reposter",
    commandCount: 18,
    description: "Repost media from social links.",
  },
  {
    id: "roleplay",
    name: "Roleplay",
    commandCount: 59,
    description: "Anime roleplay reaction commands.",
  },
  {
    id: "security",
    name: "Security",
    commandCount: 237,
    description: "Anti-nuke, anti-raid, and server protection.",
  },
  {
    id: "socials",
    name: "Socials",
    commandCount: 22,
    description: "Look up profiles on external platforms.",
  },
  {
    id: "statistics",
    name: "Statistics",
    commandCount: 48,
    description: "Bot and server statistics.",
  },
  {
    id: "track",
    name: "Track",
    commandCount: 12,
    description: "Track username, vanity, avatar, and banner changes.",
  },
  {
    id: "voicemaster",
    name: "VoiceMaster",
    commandCount: 39,
    description: "Temporary voice channels owned by the member who created them.",
  },
];

export const ZENYTH_COMMAND_COUNT = ZENYTH_MODULES.reduce(
  (total, module) => total + module.commandCount,
  0,
);

export const ZENYTH_PREFIX = process.env.ZENYTH_PREFIX ?? ";";
