# Wyzie Subs: Stremio Addon

Subtitle addon for Stremio backed by [Wyzie Subs](https://sub.wyzie.io). Aggregates OpenSubtitles, SubDL, Podnapisi and more in one click.

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
| **hi** | Prefer hearing-impaired subs. |

## Publish to the central catalog

Set `PUBLISH_URL=https://your-public-url/manifest.json` and start the server. The SDK will register with Stremio's central catalog.

## How it maps to the Wyzie API

| Stremio | Wyzie `/search` |
| ------- | --------------- |
| `id` (e.g. `tt1234567` or `tt1234567:1:2`) | `id`, `season`, `episode` |
| addon config `languages` | `language` |
| addon config `hi` | `hi` |
| (constant) | `format=srt` |

## Quota behaviour

When Wyzie returns 402 (paid balance empty) or 429 (free daily cap hit), the addon surfaces a single pseudo-subtitle pointing the user at `store.wyzie.io/pricing`, converting a dead-end into an upgrade.
