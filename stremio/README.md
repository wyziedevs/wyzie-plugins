# Wyzie Subs: Stremio Addon

Subtitle addon for Stremio backed by [Wyzie Subs](https://sub.wyzie.io): subtitles from OpenSubtitles, IndexSubtitle and, on Pro keys, five more providers, through the Wyzie Subs API.

## Install (hosted)

1. Get a free API key at [store.wyzie.io/redeem](https://store.wyzie.io/redeem).
2. Open `https://stremio.wyzie.io/configure`, paste your key, pick languages, click **Install**.

## Run locally

```bash
cd stremio
npm install
npm start
```

Then open `http://127.0.0.1:7000/configure`, paste your key, and install into Stremio.

## Configuration

| Field | Description |
| ----- | ----------- |
| **apiKey** | Wyzie key. Free at [store.wyzie.io/redeem](https://store.wyzie.io/redeem). |
| **languages** | Language codes, comma-separated. Empty = all. `pb` is Portuguese (Brazil) (`pt` includes it). Hand-typed codes are normalized before they reach the API, which takes two-letter codes only: `pt-BR` → `pb`, `zh-TW` / `zh-Hant` → `zt`, other regions to the base language (`es-419`, `es-MX` → `es`), `eng` → `en`; anything else is dropped. |
| **hi** | Prefer hearing-impaired (SDH) subs: they are listed first, the rest are still shown. |
| **plain** | Clean formatting (`plain=1` on each download): strips styling tags, fixes overlapping or repeated lines. |
| **dual** | Pro. A two-letter code. The best 8 subtitles in your configured languages (English when none are set), other than the dual language, get a "+ Language" copy (`dual=<code>`) showing that language under each line; listed first, the single-language ones stay. |
| **ai** | Pro. One AI-translated subtitle per configured language: the one for exactly that language (`en` → English, not English (Australia); `pb` → Portuguese (Brazil)), a regional variant only when there is no plain one. |
| **sdh** | Pro. Remove hearing-impaired text (`sdh=strip`). |
| **clean** | Pro. Mask strong profanity, English (`clean=1`). |

Syncing to the audio is not an addon option: Stremio never gives an addon the video's audio, so the configure page links to [Wyzie Synced](https://sub.wyzie.io/synced), which does it in the browser. The configure page enables the Pro options only once the key checks out as Pro. The download options go on Wyzie `/c/` links only (never on AI `/translate` links or image subtitles). Subtitles made for the same release as the playing file (Stremio's `filename` extra) are ranked first and marked ✓. Every subtitle id includes the title (`imdb[.season.episode]`), so Stremio never reuses one title's subtitle for another.

## Publish to the central catalog

Set `PUBLISH_URL=https://your-public-url/manifest.json` and start the server. The SDK will register with Stremio's central catalog.

## How it maps to the Wyzie API

| Stremio | Wyzie `/search` |
| ------- | --------------- |
| `id` (e.g. `tt1234567` or `tt1234567:1:2`) | `id`, `season`, `episode` |
| addon config `languages` | `language` |
| (constant) | `format=srt`, `source=all` |

`hi` is deliberately **not** sent: on Wyzie it is a hard filter that returns only SDH subtitles. The `hi` option sorts SDH subtitles first instead. Wyzie's ISO 639-1 `language` is mapped to the ISO 639-2/B code Stremio expects (`en` → `eng`, `fr` → `fre`, `de` → `ger`, …) so Stremio shows the language name and can auto-select it. Regional ones get Stremio's own codes: `pb` / `pt-BR` → `pob`, `zt` / `zh-TW` / `zh-Hant` → `zht`, `ea` / `es-419` / `es-MX` → `spl`.

Each subtitle's `url` is the Wyzie link itself. Stremio's player already routes subtitles through the user's streaming server when there is one (and falls back to the link), so the addon does not point at `127.0.0.1:11470`, which broke Stremio Web on phones and TVs.

## Errors and quota

Instead of an empty list, the addon shows one notice row (selecting it also shows the message on screen) that says what Wyzie answered. The Node SDK variant (`addon.js`) shows the same notices; its rows link to the hosted `stremio.wyzie.io/notice.srt` (set `WYZIE_NOTICE_BASE` to change that).

- No or malformed API key, a series id without season/episode, or no reply from Wyzie: a notice saying so.

- 403 "Key on hold": verify your site at [store.wyzie.io/verify](https://store.wyzie.io/verify), or contact support. The config page also flags a held key when you paste it.
- 403 "Provider not available on free plan": the chosen sources need Pro.
- 403 "Invalid API key": re-check the key.
- 402 (Pro balance used up): top up at [store.wyzie.io/topup](https://store.wyzie.io/topup).
- 429 (daily limit): when it resets (from `reset_at`, in UTC) and the upgrade link; plans are at [store.wyzie.io/#plans](https://store.wyzie.io/#plans).
- 400 "No subtitles found": "no subtitles found for this title".
- Any other 400 (e.g. "Invalid language format"): the API's message.
