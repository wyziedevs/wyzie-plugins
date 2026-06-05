# Jellyfin: use the Bazarr provider

There is no native Jellyfin plugin in this repo (yet). Reach for Jellyfin users via [`../bazarr`](../bazarr) instead:

- Bazarr ↔ Jellyfin is a first-class, widely-deployed integration.
- A native C# plugin would duplicate Bazarr's matching/scheduling/storage logic for marginal extra reach.

If demand justifies a native plugin later, the scaffold lives at `MediaBrowser.Plugins.Wyzie` (Jellyfin Plugin Template, targets `net8.0`) and implements `ISubtitleProvider`. Open an issue if you need it sooner.
