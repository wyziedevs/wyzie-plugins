# Wyzie Plugins

Official plugins that bring [Wyzie Subs](https://sub.wyzie.io) into popular media-server ecosystems.

| Plugin | Targets | Status |
| ------ | ------- | ------ |
| [stremio](./stremio) | Stremio (desktop / web / mobile / TV) | Ready |
| [bazarr](./bazarr) | Plex, Jellyfin, Emby, Sonarr, Radarr (via Bazarr) | Ready |
| [kodi](./kodi) | Kodi / LibreELEC / CoreELEC | Ready |
| [jellyfin](./jellyfin) | Native Jellyfin plugin | Use Bazarr (see folder) |
| [plex](./plex) | Native Plex plugin | Use Bazarr (see folder) |

## Why these targets

- **Stremio** is the #1 entry point from the [FMHY Sudo-Flix guide](https://stremio.ar0.eu/) — the largest organic traffic source for free streaming. A first-party Wyzie subtitle addon converts those users into free Wyzie keys, then into Pro.
- **Bazarr** is the de-facto subtitle layer for self-hosters running **Plex, Jellyfin, Emby, Sonarr, or Radarr**. Plex's native agent system and Jellyfin's plugin SDK both require heavy lifts for marginal reach; a Bazarr provider covers all five at once.
- **Kodi** is huge on Android TV / Fire TV / Raspberry Pi piracy boxes and has a first-class subtitle addon API.

## Conversion funnel

Every plugin links the user to [`store.wyzie.io/redeem`](https://store.wyzie.io/redeem) to obtain a free key on first run, and surfaces a Pro upsell when the daily limit is hit.

## License

MIT.
