# Zenyth Discord Bot

Zenyth is a Discord bot with a category-based help menu and clean, white-accent information embeds.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DISCORD_BOT_TOKEN` — saved as a Replit Secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, Discord.js 14
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

- Prefix commands: `;help`, `;commands`, and `;botinfo`
- The help catalog includes 2,278 names and descriptions. The help menu lists the 22 named modules; uncategorized entries remain searchable but are not shown as an “Other commands” menu option.
- Command engine: `artifacts/api-server/src/kyzen/commands/`. The dispatcher resolves the longest command path (with aliases), checks permissions, and shows the usage page when a group is run bare or required parameters are missing.
- Real handlers: vanity (full tree + presence watcher), voice (all), moderation core (ban, kick, timeout, warn, purge, slowmode, lockdown, nickname, topic, pin...), economy basics, roleplay actions, ship.
- Settings engine (`handlers/generic.ts`): enable/disable/add/remove/list/view/clear/reset/set-style commands in config, security, confessions, feeds, reposter, track, voicemaster, statistics, socials, esports, minecraft save and show per-server settings. Saving does not yet trigger behavior (anti-nuke, feeds, etc.).
- Everything else still shows its reference page. Data is stored in `data/store.json` (override with `ZENYTH_DATA_DIR`).
- Needs the Presence, Server Members and Message Content intents enabled in the Discord Developer Portal.
- Documentation and website links remain placeholders; support, partner, and Administrator invite links are user-provided.
- All Discord embeds use a white accent color; UI copy contains no emoji.

## Required environment

- `DISCORD_BOT_TOKEN` — Discord bot token, stored as a Replit Secret
- `ZENYTH_PREFIX` — optional command prefix; defaults to `;`
- Enable the Message Content Intent for the bot in Discord Developer Portal to receive prefix commands.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
