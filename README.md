# Revenge Relationship Notifier

An experimental Revenge plugin for local relationship-change alerts.

## Current alpha (`0.1.0-alpha.1`)

Implemented:

- Friend-list disappearance detection
- Server disappearance detection
- Group-DM disappearance detection
- Startup/reconnect snapshots
- Second-check confirmation to reduce false alerts
- Local history storage when Revenge's storage API is available
- Compatibility report for Discord `337.10`

Scaffolded but **not enabled yet**:

- Focus people
- Selected servers and group DMs
- Mutual-friend graph capture
- Two-hour priority checks
- Six-hour related-person checks
- Settings/history user interface

The mutual-friend part needs one on-device compatibility test first because Discord changes the internal mobile profile module frequently.

## Install during testing

After uploading this repository and enabling GitHub Pages, add:

`https://lapialregalia.github.io/Revenge-Relationship-Notifier/`

to Revenge's plugin installer.

## First test

1. Install and enable the plugin.
2. Fully restart Discord.
3. Wait about 60 seconds.
4. Check whether the toast says the alpha loaded.
5. Open Revenge logs and look for:
   - `[relationship-notifier] Loaded`
   - the compatibility object
6. Send the compatibility object or screenshot back for the next build.

The plugin exposes `globalThis.RelationshipNotifierDebug` for debugging if Revenge's developer console is available.

## Privacy

All snapshots and history are intended to remain local. This repository contains no analytics, webhooks, token collection, or remote database code.

## Important limitations

A disappeared server does not prove whether you were kicked, banned, the server was deleted, or access was temporarily lost. Mutual-friend changes also cannot prove which person initiated a removal.

Client modifications may violate Discord's terms. Use at your own risk.
