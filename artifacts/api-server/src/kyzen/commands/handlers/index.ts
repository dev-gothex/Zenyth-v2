import { ECONOMY_HANDLERS } from "./economy";
import { MODERATION_HANDLERS } from "./moderation";
import { ROLEPLAY_HANDLERS } from "./roleplay";
import { VANITY_HANDLERS } from "./vanity";
import { VOICE_HANDLERS } from "./voice";
import type { Handler } from "../types";

/** Exact command path -> handler. Anything not listed falls through to the
 *  generic settings engine, then to the usage page. */
export const HANDLERS = new Map<string, Handler>(
  Object.entries({
    ...ECONOMY_HANDLERS,
    ...ROLEPLAY_HANDLERS,
    ...MODERATION_HANDLERS,
    ...VANITY_HANDLERS,
    ...VOICE_HANDLERS,
  }),
);
