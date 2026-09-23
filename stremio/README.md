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
| **languages** | ISO 639-1 codes, comma-separated. Empty = all. |
| **hi** | Prefer hearing-impaired (SDH) subs: they are listed first, the rest are still shown. |

## Publish to the central catalog

Set `PUBLISH_URL=https://your-public-url/manifest.json` and start the server. The SDK will register with Stremio's central catalog.

## How it maps to the Wyzie API

| Stremio | Wyzie `/search` |
| ------- | --------------- |
| `id` (e.g. `tt1234567` or `tt1234567:1:2`) | `id`, `season`, `episode` |
| addon config `languages` | `language` |
| (constant) | `format=srt`, `source=all` |

`hi` is deliberately **not** sent: on Wyzie it is a hard filter that returns only SDH subtitles. The `hi` option sorts SDH subtitles first instead. Wyzie's ISO 639-1 `language` is mapped to the ISO 639-2/B code Stremio expects (`en` → `eng`, `fr` → `fre`, `de` → `ger`, …) so Stremio shows the language name and can auto-select it.

## Errors and quota

Instead of an empty list, the hosted addon (`worker.js`) shows one notice row (selecting it also shows the message on screen) that says what Wyzie answered. The Node SDK variant (`addon.js`) shows the same messages, except that no results is simply an empty list.

- 403 "Key on hold": verify your site at [store.wyzie.io/verify](https://store.wyzie.io/verify), or contact support. The config page also flags a held key when you paste it.
- 403 "Provider not available on free plan": the chosen sources need Pro.
- 403 "Invalid API key": re-check the key.
- 402 (Pro balance used up): top up at [store.wyzie.io/topup](https://store.wyzie.io/topup).
- 429 (daily limit): when it resets (from `reset_at`, in UTC) and the upgrade link; plans are at [store.wyzie.io/#plans](https://store.wyzie.io/#plans).
- 400 "No subtitles found": "no subtitles found for this title".
