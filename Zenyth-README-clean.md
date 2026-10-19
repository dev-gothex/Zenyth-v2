::: {align="center"}
# Z E N Y T H

**A multipurpose Discord bot for moderation, security, and community
management**

> "Build a better community, one server at a time."

[Repository](https://github.com/dev-gothex/Zenyth-v2) · [Support
Server](https://discord.gg/ztZwb9fGyZ)
:::

------------------------------------------------------------------------

> **About Zenyth**
>
> Zenyth is a feature-rich Discord bot project focused on server
> moderation, security, community engagement, utilities, and
> voice-channel management. This repository contains the bot API/server
> and supporting workspace packages.

------------------------------------------------------------------------

## Features

  -----------------------------------------------------------------------
  Category                            Description
  ----------------------------------- -----------------------------------
  **Moderation**                      Member moderation, message cleanup,
                                      channel lockdowns, moderation
                                      history, and appeals.

  **Server Security**                 Anti-raid and anti-nuke protection,
                                      alongside server-safety tools.

  **Community**                       Confessions, polls, games,
                                      roleplay, family features, and
                                      engagement tools.

  **Economy**                         Virtual balances, rewards, and
                                      server economy features.

  **Voice Tools**                     Temporary voice channels and
                                      voice-channel management.

  **Utilities**                       Server and member information,
                                      tracking tools, and general-purpose
                                      commands.

  **Integrations**                    Feed notifications and selected
                                      external-platform lookups.
  -----------------------------------------------------------------------

> Available commands depend on configuration, permissions, and enabled
> modules. Use the bot's help commands or interface for the current
> command list.

------------------------------------------------------------------------

## Technology

-   **Runtime:** Node.js
-   **Language:** TypeScript
-   **Package manager:** pnpm
-   **Discord library:** discord.js v14
-   **API server:** Express
-   **Additional packages:** Shared API/schema and database packages,
    plus a Vite/React mockup sandbox

------------------------------------------------------------------------

## Getting Started

### Requirements

-   A supported version of Node.js
-   pnpm
-   A Discord application and bot token for Discord-connected features
-   Any database or service credentials required by the modules you plan
    to run

### Installation

``` bash
git clone https://github.com/dev-gothex/Zenyth-v2.git
cd Zenyth-v2
pnpm install
```

### Environment Configuration

Configure the environment variables required by the server and the
modules you enable. Check the source code and deployment configuration
for the exact variable names.

> **Security note:** Never commit bot tokens, API keys, database
> credentials, or other secrets to the repository.

### Type-check and Build

``` bash
pnpm run typecheck
pnpm run build
```

The API server package may provide separate build and start scripts.
Follow the scripts and deployment requirements for the package you
intend to run.

------------------------------------------------------------------------

## Project Links

  --------------------------------------------------------------------------------------------------
  Resource                            Link
  ----------------------------------- --------------------------------------------------------------
  **Repository**                      [Zenyth-v2 on GitHub](https://github.com/dev-gothex/Zenyth-v2)

  **Terms of Service**                [Read the
                                      Terms](https://dev-gothex.github.io/Zenyth-v2/terms.html)

  **Privacy Policy**                  [Read the Privacy
                                      Policy](https://dev-gothex.github.io/Zenyth-v2/privacy.html)

  **Support Server**                  [Join the support server](https://discord.gg/ztZwb9fGyZ)
  --------------------------------------------------------------------------------------------------

------------------------------------------------------------------------

## Permissions and Safety

Configure Zenyth with only the Discord permissions it needs. Some
commands require elevated server permissions, and availability may
depend on the permissions of the person invoking them. Review all
settings carefully before enabling moderation or security automation.

## Policies

By using Zenyth, users should review the [Terms of
Service](https://dev-gothex.github.io/Zenyth-v2/terms.html) and [Privacy
Policy](https://dev-gothex.github.io/Zenyth-v2/privacy.html).

> Keep these policies accurate and up to date. They should reflect the
> bot's actual data collection, processing, storage, and deletion
> practices.

## Contributing

Bug reports, suggestions, and contributions are welcome. Describe
changes clearly when opening an issue or pull request, and run the
relevant checks before submitting. Do not include secrets, private user
data, or server-specific credentials.

## License

The root `package.json` currently declares the MIT license. Confirm that
the repository contains the appropriate `LICENSE` file and that you have
the rights to distribute all included code and assets before publishing.

------------------------------------------------------------------------

::: {align="center"}
> "Make it useful. Keep it reliable. Keep building."

**Zenyth**
:::
