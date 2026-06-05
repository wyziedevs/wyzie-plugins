# Wyzie Subs: Kodi Addon

Subtitle service for Kodi 19+ (Matrix and later), LibreELEC, CoreELEC. Uses Kodi's standard `xbmc.subtitle.module` extension point.

## Install

1. Get a free key at [store.wyzie.io/redeem](https://store.wyzie.io/redeem).
2. Zip the `kodi/` folder as `service.subtitles.wyzie-1.0.0.zip` (the folder must contain `addon.xml`).
3. In Kodi: **Settings → Add-ons → Install from zip file** → choose the zip.
4. **Settings → Player → Language → Default subtitle service** → Wyzie Subs.
5. Open Wyzie's addon settings, paste your API key.

## Layout

```
kodi/
├── addon.xml          Kodi addon manifest
├── service.py         search/download handlers
└── resources/
    └── settings.xml   user-facing settings (api_key, prefer_hi)
```

## How matching works

Kodi exposes `VideoPlayer.IMDBNumber`, `VideoPlayer.Season`, `VideoPlayer.Episode` infolabels while playback is active. The addon reads those, hits `sub.wyzie.io/search`, and returns candidates. Languages are pulled from Kodi's selected subtitle languages and mapped to ISO 639-1.

Manual search (`action=manualsearch`) currently no-ops with a notification. Wyzie's API is IMDB/TMDB-id driven, not title-driven. A title→IMDB lookup via TMDB is on the roadmap.

## Quota behaviour

402 / 429 surface a toast pointing the user at `store.wyzie.io/pricing`.

## Publish to a Kodi repo

For real distribution, ship via a Kodi addon repository (e.g. a public-facing GitHub repo with a `repository.wyzie` add-on). Same pattern as any third-party repo.
