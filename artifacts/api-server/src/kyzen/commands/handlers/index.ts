import { AUTOMATION_HANDLERS } from "./automation";
import { CONFESSION_HANDLERS } from "./confessions";
import { EMBED_HANDLERS } from "./embedbuilder";
import { ENGAGEMENT_HANDLERS } from "./engagement";
import { GREETING_HANDLERS } from "./greetings";
import { INTERFACE_HANDLERS } from "./interface";
import { STATISTICS_HANDLERS } from "./statistics";
import { TRACK_HANDLERS } from "./track";
import { VOICEMASTER_HANDLERS } from "./voicemaster";
import { ECONOMY_HANDLERS } from "./economy";
import { FAMILY_HANDLERS } from "./family";
import { FUN_HANDLERS } from "./fun";
import { UTILITY_HANDLERS } from "./utility";
import { PREFIX_HANDLERS } from "./prefixcmd";
import { LOGGING_HANDLERS } from "./logging";
import { MODERATION_HANDLERS } from "./moderation";
import { MODLOG_HANDLERS } from "./modlog";
import { MODPUNISH_HANDLERS } from "./modpunish";
import { MODTOOLS_HANDLERS } from "./modtools";
import { ROLEPLAY_HANDLERS } from "./roleplay";
import { VANITY_HANDLERS } from "./vanity";
import { VOICE_HANDLERS } from "./voice";
import type { Handler } from "../types";

/** Exact command path -> handler. Anything not listed falls through to the
 *  generic settings engine, then to the usage page. */
export const HANDLERS = new Map<string, Handler>(
  Object.entries({
    ...ECONOMY_HANDLERS,
    ...UTILITY_HANDLERS,
    ...FUN_HANDLERS,
    ...FAMILY_HANDLERS,
    ...AUTOMATION_HANDLERS,
    ...STATISTICS_HANDLERS,
    ...ROLEPLAY_HANDLERS,
    ...MODERATION_HANDLERS,
    ...PREFIX_HANDLERS,
    ...MODLOG_HANDLERS,
    ...MODTOOLS_HANDLERS,
    ...MODPUNISH_HANDLERS,
    ...VANITY_HANDLERS,
    ...VOICE_HANDLERS,
    ...VOICEMASTER_HANDLERS,
    ...INTERFACE_HANDLERS,
    ...CONFESSION_HANDLERS,
    ...TRACK_HANDLERS,
    ...GREETING_HANDLERS,
    ...LOGGING_HANDLERS,
    ...EMBED_HANDLERS,
    ...ENGAGEMENT_HANDLERS,
  }),
);

/** Commands that should run even when called with no arguments. */
export const BARE_OK = new Set(["afk", "info", "timezone", "level", "birthday", "modcases", "prefix", "prefix self", "stats", "messages", "vctime", "streaks"]);

/** Commands that handle a missing or partial argument list themselves. */
export const LOOSE_ARGS = new Set(["embed create", "embed edit", "embed wizard"]);
