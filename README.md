# Ent Bot v1

Standalone SWG entertainer bot for:

- starting dance or music performance loops
- optionally sending server-native pet control device call packets during startup
- firing flourish commands on an interval
- running one-time startup commands with a configurable pause between each command
- posting rotating advert messages to game chat commands like `spatialChat` and `planetSay`
- auto-inviting players who send a tell
- running multiple entertainers at once in band mode

## Setup

1. Run `npm install`
2. Copy `.env.example` to `.env`
3. Fill in your SWG login and character settings
4. Start the bot with `npm start`

## Main Settings

- `ENT_BOT_CHARACTER`: entertainer character name
- `ENT_BOT_PERFORMANCE_TYPE`: `dance` or `music`
- `ENT_BOT_PERFORMANCE_COMMAND`: one explicit performance command to run
- `ENT_BOT_PERFORMANCE_COMMANDS`: JSON array of commands for fully custom performance loops
- `ENT_BOT_STARTUP_COMMANDS`: JSON array of one-time commands to run after connect
- `ENT_BOT_PET_AUTO_CALL_ENABLED`: enable startup pet control device calls
- `ENT_BOT_PET_AUTO_GROUP_ENABLED`: send a post-summon pet group command after all auto-calls finish
- `ENT_BOT_PET_AUTO_GROUP_COMMAND`: group command to send after summon, defaults to `/tellpet group`
- `ENT_BOT_PET_DISCOVERY_ENABLED`: log discovered pet/control-device candidates from datapad traffic
- `ENT_BOT_PET_CONTROL_DEVICE_IDS`: comma-separated pet control device object IDs
- `ENT_BOT_PET_CALL_RADIAL_ID`: radial menu selection to send, defaults to `44`
- `ENT_BOT_PET_CALL_PAUSE_MS`: pause between pet control device calls in milliseconds
- `ENT_BOT_PET_AUTO_GROUP_DELAY_MS`: extra delay after the last summon before grouping pets
- `ENT_BOT_DANCE_COMMAND`: default dance command, for example `/startdance exotic4`
- `ENT_BOT_MUSIC_COMMAND`: default music command, for example `/startmusic starwars1`
- `ENT_BOT_FLOURISH_COMMAND`: flourish command, for example `/flourish 2`
- `ENT_BOT_STARTUP_COMMAND_PAUSE_MS`: pause between startup commands in milliseconds
- `ENT_BOT_INTERVAL_MS`: loop interval for dance/flourish
- `ENT_BOT_AUTO_INVITE_ON_TELL`: auto-send `/invite <tell sender>`
- `ENT_BOT_ADVERTS_ENABLED`: enable repeated advert posts
- `ENT_BOT_ADVERT_MESSAGE`: single advert text to post
- `ENT_BOT_ADVERT_CHANNELS`: comma-separated game commands such as `spatialChat,planetSay`
- `ENT_BOT_CONNECTION_REFRESH_INTERVAL_MINUTES`: force a clean reconnect on a fixed interval, defaults to `30`

## Band Mode

Use `ENT_BOT_ENTERTAINERS` in your `.env` to supply a JSON array directly. Each entertainer can override login and performance settings while inheriting shared defaults like login server, timing, adverts, and reconnect behavior.

Example:

```json
[
  {
    "character": "DancerOne",
    "username": "acct1",
    "password": "pw1",
    "performanceType": "dance",
    "petDiscoveryEnabled": true,
    "petAutoCallEnabled": true,
    "petAutoGroupEnabled": true,
    "petControlDeviceIds": ["123456789012345678", "123456789012345679"],
    "petCallRadialId": 44,
    "petCallPauseMs": 3000,
    "petAutoGroupDelayMs": 3000,
    "danceCommand": "/startdance exotic4",
    "startupCommandPauseMs": 3000
  },
  {
    "character": "MusicianOne",
    "username": "acct2",
    "password": "pw2",
    "performanceType": "music",
    "petDiscoveryEnabled": true,
    "petAutoCallEnabled": true,
    "petAutoGroupEnabled": true,
    "petControlDeviceIds": ["223456789012345678"],
    "musicCommand": "/startmusic starwars1",
    "startupCommands": ["/say musician online"]
  }
]
```

## Notes

- This bot does not depend on Discord.
- It uses the same low-level SWG protocol/client code as the SWG Chatbot.
- Each entertainer now runs in its own isolated SWG client session, which enables multi-login band mode in one process.
- This remains a headless server client. It does not use or require a visible game client.
- The bot can now also load a JSON settings file by setting `ENT_BOT_SETTINGS_FILE=/path/to/settings.json`. The new WPF host uses this path instead of `.env`.
- Pet/control-device discovery is now packet-based: the bot watches scene create, baseline, and containment traffic and logs candidate control-device IDs as they appear.
- Candidate discovery now includes a best-effort label pulled from STF names and payload hints, so things like `at_st` and helper droids are easier to spot in logs.
- The current pet-call route is still partly manual: discovery helps you find IDs, but auto-populating `ENT_BOT_PET_CONTROL_DEVICE_IDS` is not implemented yet.
- Upstream Core3 handles pet control device object-menu selections with radial IDs `44` and `59`, and `44` is the default used here for explicit call behavior.
- Upstream `tellpet` fans the command to all active pets in range, so `ENT_BOT_PET_AUTO_GROUP_ENABLED=true` is the intended way to group pets only after the full summon pass completes.

## WPF Standalone Packaging

- The WPF host lives in `EntBot.Wpf`.
- During development it can use `node` from `PATH`.
- For standalone releases it prefers a bundled runtime at `runtime/node/node.exe`.
- To build a standalone Windows publish, run `EntBot.Wpf/Publish-Standalone.ps1`.
- The publish script now defaults update packages to the GitHub release repo at `mannax2012/EntBot.Wpf`.
- The publish script now produces:
  - `publish/win-x64/app/` as the install-ready folder
  - `publish/win-x64/EntBot-win-x64-v<version>.zip` as the update package
  - `publish/win-x64/version.json` as the update manifest
- The main executable is now `EntBot.exe`.
- A bundled updater is included under `updater/EntBot.Updater.exe`.

## Self-Update Flow

- The desktop app reads its local version from `EntBot.Wpf/version.json`, which is copied into the published app folder.
- The desktop app reads update-source settings from `update-settings.json`.
- `update-settings.json` now points at:
  - `https://raw.githubusercontent.com/mannax2012/EntBot.Wpf/master/version.json`
- The remote `version.json` manifest includes:
  - `version`
  - `packageUrl`
  - `sha256`
  - `publishedAtUtc`
  - `releaseNotes`
- When the app finds a newer version, it downloads the zip package, closes the main app, launches `EntBot.Updater`, applies the package, and reopens `EntBot.exe`.
- `bot-settings.json` and `update-settings.json` are preserved across updates so local configuration is not overwritten.

## Release Process

1. Update `EntBot.Wpf/version.json` with the new app version and release notes.
2. Run `EntBot.Wpf/Publish-Standalone.ps1`.
3. Create a GitHub release tag named `v<version>` in `mannax2012/EntBot.Wpf`.
4. Upload `EntBot.Wpf/publish/win-x64/EntBot-win-x64-v<version>.zip` to that release.
5. Upload or commit `EntBot.Wpf/publish/win-x64/version.json` to the repo root as `version.json`.

The publish script already writes the package URL in the format:

- `https://github.com/mannax2012/EntBot.Wpf/releases/download/v<version>/EntBot-win-x64-v<version>.zip`
