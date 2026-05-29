# Wyzie Subs — Bazarr Provider

Adds Wyzie as a subtitle provider in [Bazarr](https://www.bazarr.media/), which feeds **Plex, Jellyfin, Emby, Sonarr and Radarr** in a single integration.

> Native plugins for Plex (Agent SDK is deprecated) and Jellyfin (heavy C# build) provide marginal extra reach. Bazarr is how self-hosters actually wire subtitles into those servers — so we ship a Bazarr provider instead.

## Install

1. Get a free key at [store.wyzie.io/redeem](https://store.wyzie.io/redeem).
2. Locate your Bazarr install (typical Docker path: `/opt/bazarr/bazarr/`).
3. Copy `wyzie.py` to `bazarr/subliminal_patch/providers/wyzie.py`.
4. Edit `bazarr/subliminal_patch/extensions.py` and add `wyzie` to `provider_registry` and `provider_manager`.
5. Edit `bazarr/list_subtitles.py` (or `bazarr/config.py`, depending on version) to expose `api_key`, `prefer_hi`, `sources` settings — copy the pattern from any existing provider (e.g. `opensubtitlescom`).
6. Restart Bazarr.
7. **Settings → Providers → Wyzie**, paste your key, save.

A first-class PR upstreaming the provider into Bazarr is the long-term plan; for now this is a drop-in.

## Configuration

| Field | Default | Description |
| ----- | ------- | ----------- |
| `api_key` | — | Wyzie key (required). |
| `prefer_hi` | false | Prefer hearing-impaired subs. |
| `sources` | `all` | Comma list of providers to query, or `all`. |

## Quota behaviour

- HTTP 402 (paid balance empty) and 429 (daily limit hit) are logged with a link to `store.wyzie.io/pricing` and return an empty list — Bazarr will fall back to other providers, no crash.
- HTTP 401 raises `AuthenticationError` so the user is prompted to re-enter the key.

## Status

Functional drop-in. Upstream PR to Bazarr is tracked separately.
