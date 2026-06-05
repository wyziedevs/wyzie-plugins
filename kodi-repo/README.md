# Wyzie Kodi Repository

Scaffolding to publish the Wyzie Subs Kodi add-on as a proper Kodi **repository**, so
users install once and get automatic updates (instead of re-installing a zip each time).

## What's here

```
kodi-repo/
├── repository.wyzie/addon.xml   The repository add-on (edit the host URLs in this file)
├── build.sh                     Packages everything into ./dist for hosting
└── README.md                    You're reading it
```

The actual subtitle add-on lives one level up in [`../kodi`](../kodi). `build.sh` packages
both it and the repository add-on.

## Publish it (3 steps)

1. **Pick a host URL** and set it in `repository.wyzie/addon.xml` — replace the three
   `https://kodi.wyzie.io/...` URLs with wherever you'll serve the files (GitHub Pages, a
   Cloudflare R2 bucket, S3, nginx, …). All three must share the same base.

2. **Build:**
   ```bash
   cd kodi-repo
   ./build.sh
   ```
   This writes `dist/addons.xml`, `dist/addons.xml.md5`, and `dist/zips/...`.
   Requirements: `bash`, `zip`, and `md5sum` (or `md5`). On Windows use Git Bash or WSL.

3. **Upload** the contents of `dist/` to your host so that, for the base URL you chose:
   - `…/addons.xml` and `…/addons.xml.md5` resolve, and
   - `…/zips/repository.wyzie/repository.wyzie-<ver>.zip` resolves.

   Then hand users the **`repository.wyzie-<ver>.zip`** (link it from the store /plugins
   page and the docs). They install it via **Settings → Add-ons → Install from zip file**,
   after which Wyzie Subs appears under **Install from repository → Wyzie Repository** and
   updates itself.

### GitHub Pages quick path

Commit `dist/` to a `gh-pages` branch (or a `/docs` folder on `main`) of a public repo and
enable Pages. Your base URL becomes `https://<user>.github.io/<repo>/`. Put that base into
`repository.wyzie/addon.xml`, rebuild, and re-upload.

## Still TODO (manual)

- **Icon:** `../kodi/addon.xml` references `resources/icon.png`, which isn't in the repo
  yet. Add a 256×256 (or 512×512) PNG at `../kodi/resources/icon.png` before building, or
  Kodi shows a placeholder.
- **Bump versions** in `../kodi/addon.xml` (and `repository.wyzie/addon.xml` if its URLs
  change) for each release, then rebuild — Kodi keys updates off the version string.
