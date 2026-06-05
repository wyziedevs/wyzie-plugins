# Testing the Wyzie plugins (without using the apps)

All three plugins (Stremio, Bazarr, Kodi) are thin clients over the same
`GET https://sub.wyzie.io/search` endpoint. So you can test almost everything
**without installing Stremio, Plex, Jellyfin, or Kodi**. These scripts replay
the exact request each plugin builds and assert the response is usable.

## Prerequisites

- A valid Wyzie API key (`wyzie-` + 32 chars). Get one at
  https://store.wyzie.io/redeem, or use an existing paid key.
- Node 18+ (for Stremio) and Python 3.8+ with `requests` (for Bazarr/Kodi).
- One-time: `cd stremio && npm install` (installs the Stremio addon SDK).

Set the key once per shell:

```bash
# bash
export WYZIE_KEY=wyzie-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
```powershell
# PowerShell
$env:WYZIE_KEY="wyzie-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

> Use a standard issued key (`wyzie-` + 32 hex). Vanity keys (e.g.
> `wyzie-heyxprime-infinite`) and legacy `paid-…` keys fail the `source=all`
> prefilter; see "Known issues" below.

## 1. Shared API contract (covers all three at once)

```bash
node tests/contract.mjs
```
Replays the movie/series request shape for each plugin, downloads a real
subtitle file, and checks the invalid-key path. If this passes, the foundation
all three plugins depend on is healthy.

## 2. Stremio: full end-to-end, no Stremio install

```bash
node tests/stremio.e2e.cjs
```
Boots the actual addon over HTTP and queries `/manifest.json` and the
`/<config>/subtitles/...` endpoints exactly as the Stremio app does.

### See it in a real client (browser only, no desktop install)

```bash
KEEP_ALIVE=1 node tests/stremio.e2e.cjs
```
It prints an install URL like
`http://127.0.0.1:7799/<config>/manifest.json`. Then:
1. Open https://web.stremio.com and log in.
2. Add-ons → "Add addon" (paste box) → paste the printed URL → Install.
3. Play any movie/series, open the subtitle menu, and Wyzie entries appear.

(`127.0.0.1` works because web.stremio.com allows localhost addons. To test on
a phone/TV instead, deploy the addon and use its public URL.)

## 3. Bazarr: provider logic, no Bazarr install

```bash
python tests/bazarr_test.py
```
Stubs the subliminal/subzero module surface and drives the real
`WyzieProvider.list_subtitles` / `download_subtitle` against the live API with
a fake Movie/Episode. (The `Wyzie 403:` log line during the run is the
provider's own logging on the deliberate bad-key test, expected.)

## 4. Kodi: service logic, no Kodi install

```bash
python tests/kodi_test.py
```
Stubs the `xbmc*` modules and drives the real `search()` / `download()` logic:
language mapping, IMDB extraction, request building, result→ListItem mapping,
and the actual file download.

### The one manual check worth installing an app for

Kodi's stubs can't verify the subtitle actually renders in the player. Kodi is
free and installs on Windows in a couple minutes:

1. Install Kodi (https://kodi.tv) → it runs on your desktop.
2. Zip the `kodi/` folder as `service.subtitles.wyzie.zip` (the folder must
   match the `id` in `addon.xml`).
3. Kodi → Settings → Add-ons → Install from zip file → pick the zip.
4. Settings → Player → Language → "Default TV/movie subtitle service" → Wyzie.
5. Enter your API key in the addon settings.
6. Play any file with a known IMDB id, open subtitle search, and Wyzie results
   should list and download into the player.

## Known issues found while testing

- **`source=all` rejected non-standard keys.** *(Fixed in code 2026-06-01,
  pending deploy.)* `wyzie-subs-priv` `src/routes/search.get.ts` used to gate
  `source=all` behind the regex `^wyzie-[a-z0-9]{32}$` *before* real auth, so a
  paying customer on a legacy `paid-…` or vanity key (and Turnstile-only website
  callers) got a 401 despite being valid. The **Bazarr** provider defaults to
  `source=all`, so this hit Bazarr users directly. The prefilter has been
  removed; `source=all` now resolves per tier (paid → all enabled sources,
  free/dev/unkeyed → `FREE_SOURCES`), relying on the apiKey middleware for auth.
- **Intermittent `400 "No subtitles found"`** on otherwise-valid requests, when
  the upstream provider fan-out flakes. All plugins treat this as "no subtitles"
  and show nothing. If a test fails with 0 results, re-run; if it passes on
  retry, it was this. Worth adding a server-side retry/grace path.
