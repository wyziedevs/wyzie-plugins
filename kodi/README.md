# Wyzie Subs: Kodi Addon

Subtitle service for Kodi 19+ (Matrix and later), LibreELEC, CoreELEC. Uses Kodi's standard `xbmc.subtitle.module` extension point.

## Install

1. Get a free key at [store.wyzie.io/redeem](https://store.wyzie.io/redeem).
2. Zip the `kodi/` folder as `service.subtitles.wyzie-1.1.1.zip` (the folder must contain `addon.xml`), or install the Wyzie repository from `https://kodi.wyzie.io/repository.wyzie.zip` to get updates automatically.
3. In Kodi: **Settings → Add-ons → Install from zip file** → choose the zip.
4. **Settings → Player → Language → Default subtitle service** → Wyzie Subs.
5. Open Wyzie's addon settings, paste your API key.

## Layout

```
kodi/
├── addon.xml          Kodi addon manifest
├── service.py         search/download handlers
└── resources/
    └── settings.xml   user-facing settings (General + Pro features)
```

## How matching works

While something plays, the add-on works out which title it is and asks `sub.wyzie.io/search` with `source=all` (every provider the key's tier allows: OpenSubtitles on a free key, all of them on Pro):

- **Movies:** `VideoPlayer.UniqueID(imdb)`, else `VideoPlayer.UniqueID(tmdb)` (sent as a bare TMDB id). On Kodi builds without `UniqueID(type)` it falls back to `VideoPlayer.IMDBNumber`, which is the item's *default* unique id: a `tt…` value is used as an IMDb id, digits as a TMDB id (never turned into `tt<digits>`).
- **Episodes:** the **show's** id plus `VideoPlayer.Season` / `VideoPlayer.Episode`. For library items the show's ids come from `VideoLibrary.GetTVShowDetails` (via `VideoPlayer.TvShowDBID`); otherwise from `VideoPlayer.UniqueID(tvshow.imdb)` / `(tvshow.tmdb)` or an IMDb id in `IMDBNumber`.
- **No id at all** (a plain file): the title is looked up on TMDB through `sub.wyzie.io/api/tmdb/search`.

Languages are pulled from Kodi's selected subtitle languages (English names) and mapped to ISO 639-1 with `xbmc.convertLanguage`, falling back to a built-in table of ~130 names. Portuguese (Brazil) becomes `pb` and Chinese (Traditional) `zt` (OpenSubtitles' codes, which `/search` takes); Kodi 22's "original" / "default" entries are skipped. When nothing maps, no `language=` is sent (every language).

**Manual search** (`action=manualsearch`) looks the typed text up on TMDB (`/api/tmdb/search`), picks the best match (exact title and year first), then searches by that TMDB id. Type `The Martian (2015)` or `The Martian 2015` for a movie and `Severance S01E02` (or `1x02`) for an episode; while an episode is playing its season and episode are used if you don't type them.

**Prefer hearing-impaired** lists SDH subtitles first. It does not send `hi=true`, which on Wyzie is a hard filter that would hide every other subtitle.

**Release matching:** results are ranked against the playing file's name (`Player.Filename`): shared quality/source/codec tokens count, the same release group counts most, and those subtitles get Kodi's "synced" mark. Real subtitles always come before AI ones.

Each download is saved under a fresh name (`wyzie-<ms>.<ext>`) and older ones are deleted first, so a subtitle from a previous title can never be picked up.

## Settings

| Setting | Tier | What it does |
| ------- | ---- | ------------ |
| API key | all | Required. |
| Prefer hearing-impaired | all | SDH subtitles first. |
| Clean formatting | all | `plain=1`: strips styling tags, fixes overlapping or repeated lines. |
| Dual subtitles | Pro | `dual=<lang>`: the best 8 subtitles in your subtitle languages (English when none), other than the dual language, get a `[+ Language]` copy with that language under each line, timed to match. The single-language rows stay. |
| AI translation | Pro | One AI-translated subtitle per language, for exactly that language (English, not English (Australia)); each download costs 25 requests. A busy translation service (503) shows a notification. |
| Remove hearing-impaired text | Pro | `sdh=strip`. |
| Mask profanity | Pro | `clean=1`, English. |

With a free key, Wyzie refuses the Pro options without charging (403 "Paid feature"); the add-on then downloads the plain subtitle and shows a notification.

## Quota and key messages

Search and download refusals show a notification with the reason from the API body:

- 403 "Key on hold": verify your site at `store.wyzie.io/verify` (or contact support).
- 403 "Provider not available on free plan": the chosen sources need Pro.
- 403 "Paid feature": a Pro option on a free key (the plain subtitle is downloaded instead).
- 403 "Invalid API key": re-enter the key.
- 402: Pro balance used up, top up at `store.wyzie.io/topup`.
- 429: daily limit reached, with the local reset time and the upgrade link.
- 503 "Too many translations" / "Translation unavailable" (AI download): the translation service is busy, try again in a minute (not charged).

Every download link costs one request from the key, like a search.

## Publish to a Kodi repo

For real distribution, ship via a Kodi addon repository (e.g. a public-facing GitHub repo with a `repository.wyzie` add-on). Same pattern as any third-party repo.
