# Wyzie Subs: Bazarr Provider

Adds Wyzie as a subtitle provider in [Bazarr](https://www.bazarr.media/), which feeds **Plex, Jellyfin, Emby, Sonarr and Radarr** in a single integration.

> Native plugins for Plex (Agent SDK is deprecated) and Jellyfin (heavy C# build) provide marginal extra reach. Bazarr is how self-hosters actually wire subtitles into those servers, so we ship a Bazarr provider instead.

## Install

1. Get a free key at [store.wyzie.io/redeem](https://store.wyzie.io/redeem).
2. Locate your Bazarr install (typical Docker path: `/opt/bazarr/bazarr/`).
3. Copy `wyzie.py` to `bazarr/subliminal_patch/providers/wyzie.py`.
4. Edit `bazarr/subliminal_patch/extensions.py` and add `wyzie` to `provider_registry` and `provider_manager`.
5. Edit `bazarr/list_subtitles.py` (or `bazarr/config.py`, depending on version) to expose `api_key`, `prefer_hi`, `sources` settings. Copy the pattern from any existing provider (e.g. `opensubtitlescom`).
6. Restart Bazarr.
7. **Settings → Providers → Wyzie**, paste your key, save.

A first-class PR upstreaming the provider into Bazarr is the long-term plan; for now this is a drop-in.

## Configuration

| Field | Default | Description |
| ----- | ------- | ----------- |
| `api_key` | (none) | Wyzie key (required). |
| `prefer_hi` | false | List hearing-impaired (SDH) subtitles first. It does not send `hi=true` (a hard filter on Wyzie that would drop every other subtitle); Bazarr's language-profile HI setting still decides what gets downloaded. |
| `sources` | `all` | `all`, or a comma list of source codenames (below). |

### Sources

Wyzie names its providers by codename. `all` (the default) gives each key everything its tier allows, so it never fails on tier.

| Codename | Provider | Tier |
| -------- | -------- | ---- |
| `charlie` | OpenSubtitles | free and Pro |
| `lima` | IndexSubtitle | free and Pro |
| `foxtrot` | Jimaku (anime) | Pro |
| `india` | YIFY | Pro |
| `juliet` | Ajatt-Tools (anime) | Pro |
| `mike` | anime | Pro |
| `november` | anime | Pro |

The live list is [sub.wyzie.io/sources](https://sub.wyzie.io/sources). A free key that names only Pro sources gets 403 "Provider not available on free plan"; a name that isn't live (a typo, or a retired provider such as the old `alpha`/SubDL) gets 400 "Invalid source". Both are logged with the fix and raised as a `ConfigurationError`, so Bazarr shows the provider as throttled (with the reason) instead of silently finding nothing.

## Matching

The provider searches by the video's IMDb id (for episodes, the **show's** IMDb id plus season and episode), falling back to the TMDB id. Every result is for that title, so it is credited `imdb_id` / `series_imdb_id` (which Bazarr's scoring expands to title/series and year) plus season and episode. The release names Wyzie reports are run through guessit, like other subliminal providers, so a subtitle made for the same source, resolution, codecs or release group as your file scores higher. That is what lets Wyzie results clear Bazarr's minimum score for automatic downloads instead of only showing up in manual search.

## Errors and quota

Bazarr throttles a provider by exception type, so each refusal maps to what you need to do:

| Response | Raised | Bazarr backs off |
| -------- | ------ | ---------------- |
| 403 "Invalid API key", 401 | `AuthenticationError` | 12 hours |
| 403 "Key on hold" | `WyzieKeyOnHold`: verify your site at [store.wyzie.io/verify](https://store.wyzie.io/verify), or contact support | 10 minutes, then resumes on its own |
| 403 "Provider not available on free plan", 400 "Invalid source" | `ConfigurationError` | 12 hours |
| 402 balance used up | `DownloadLimitExceeded`, with the [top-up](https://store.wyzie.io/topup) link | 3 hours |
| 429 daily limit | `DownloadLimitExceeded`, with the reset time and the [upgrade](https://store.wyzie.io/#plans) link | 3 hours |
| 503 | `ServiceUnavailable` | 20 minutes |

A 400 "No subtitles found" is just an empty result. Each subtitle download link costs one request from the key, like a search; an expired link (401) is skipped and Bazarr moves on to the next subtitle.

## Status

Functional drop-in. Upstream PR to Bazarr is tracked separately.
