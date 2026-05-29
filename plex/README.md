# Plex — use the Bazarr provider

Plex's legacy Agent / Channel plugin system has been **deprecated since Plex Media Server 1.20** (2020). New subtitle agents can't be installed the old way, and there is no public replacement SDK for third-party subtitle providers.

The supported path for getting Wyzie subtitles into Plex is [Bazarr](../bazarr):

1. Install the Wyzie Bazarr provider (see `../bazarr/README.md`).
2. Point Bazarr at your Plex library.
3. Subtitles land on disk next to the media file and Plex picks them up automatically.

If Plex ever revives a real subtitle-plugin API, we'll ship a native one here.
