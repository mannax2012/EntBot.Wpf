# Ent Bot

Ent Bot is a Windows desktop app for running Star Wars Galaxies entertainer bots without editing config files by hand.

The app lets you:

- save all bot settings inside the desktop UI
- start and stop the bot from one window
- watch the live console log
- run dance or music entertainers
- auto-invite on tell
- auto-call and group pets
- run band mode with multiple entertainers
- check for and install app updates

## Getting Started

1. Open `EntBot.exe`
2. Fill in your account and character settings
3. Choose your performance settings
4. Save your settings
5. Press `Start Bot`

The log window at the bottom of the app shows connection status, startup actions, performance state, and update messages.

## Main Tabs

## General

Use this area for:

- login address
- login port
- username
- password
- character name
- refresh connection interval

The refresh connection interval is user-editable and is used to reconnect the bot on a scheduled cycle.

## Performance Mode

Use this tab to choose:

- performance type: `dance` or `music`
- startup delays
- dance style
- music selection
- flourish behavior

Dance and music commands are built automatically by the app. You only choose the style or song.

## Pets

Use this tab for:

- enabling pet auto-call
- enabling `/tellpet group`
- entering pet control device IDs
- pet summon timing

The app uses the built-in default pet group command, so users do not need to type it manually.

## Adverts

Use this section to:

- enable or disable adverts
- set the advert message
- set advert timing
- choose advert channels

## Band Mode

Band mode lets you manage multiple entertainers inside one app.

You can:

- enable or disable band mode
- add a new band member
- edit a selected band member
- remove a selected band member
- move members up or down in the roster
- load a band member back into the main tabs for editing

Each band member can have:

- its own login
- its own character
- its own performance type
- its own dance or music choice
- its own pet settings
- its own advert setting

## Saving Settings

The app writes its settings to `bot-settings.json` in the application folder.

In band mode, the roster is also stored in that settings file, so the app can restore your saved entertainers the next time it opens.

## Updates

Use the app's update option to check for new versions.

When a newer version is found, the app can:

1. download the update package
2. close the main app
3. run the bundled updater
4. install the update
5. reopen Ent Bot

Your local settings are preserved during updates.

## Release Files

If you are downloading a release manually, the main files are:

- `EntBot.exe`
- `bot-settings.json` after first save
- `update-settings.json`
- `version.json`
- `runtime\`
- `bot\`
- `updater\`

## Notes

- The app is built for Windows.
- The app is intended to be used through the WPF desktop interface.
- The console log shown in the app is the main place to check startup and runtime status.
