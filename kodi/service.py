"""
Wyzie Subs subtitle service for Kodi.

Implements Kodi's subtitle plugin protocol:
  action=search   — list candidates
  action=manualsearch — same as search with explicit query
  action=download — fetch a chosen entry

Get a free key at https://store.wyzie.io/redeem and set it in addon settings.
"""
import os
import re
import sys
import urllib.parse

import requests
import xbmc
import xbmcaddon
import xbmcgui
import xbmcplugin
import xbmcvfs

ADDON = xbmcaddon.Addon()
ADDON_ID = ADDON.getAddonInfo("id")
PROFILE = xbmcvfs.translatePath(ADDON.getAddonInfo("profile"))
WYZIE_BASE = "https://sub.wyzie.io"

HANDLE = int(sys.argv[1])
PARAMS = dict(urllib.parse.parse_qsl(sys.argv[2].lstrip("?")))


def log(msg, lvl=xbmc.LOGINFO):
    xbmc.log(f"[wyzie] {msg}", lvl)


def setting(key):
    return ADDON.getSetting(key) or ""


def notify(msg, time_ms=5000):
    xbmcgui.Dialog().notification("Wyzie Subs", msg, time=time_ms)


def get_imdb_and_episode():
    """Pull IMDB id + season/episode from Kodi InfoLabels."""
    imdb = xbmc.getInfoLabel("VideoPlayer.IMDBNumber")
    if imdb and not imdb.startswith("tt"):
        # Some skins surface just the digits
        if re.fullmatch(r"\d+", imdb):
            imdb = f"tt{imdb}"
        else:
            imdb = None

    season = xbmc.getInfoLabel("VideoPlayer.Season")
    episode = xbmc.getInfoLabel("VideoPlayer.Episode")
    return imdb, season or None, episode or None


def search():
    key = setting("api_key")
    if not key:
        notify("Set your API key in addon settings (free at store.wyzie.io/redeem)", 8000)
        return

    imdb, season, episode = get_imdb_and_episode()
    if not imdb:
        # Manual fallback: title from PARAMS
        title = PARAMS.get("searchstring") or xbmc.getInfoLabel("VideoPlayer.Title")
        if not title:
            return
        notify("Wyzie needs an IMDB id; manual title search not supported yet")
        return

    languages = PARAMS.get("languages", "")
    lang_codes = []
    for name in languages.split(","):
        name = name.strip()
        if not name:
            continue
        # Kodi gives language *names* (e.g. "English"); map common ones
        lang_codes.append(_lang_name_to_iso(name))

    params = {"id": imdb, "key": key, "format": "srt"}
    if season and episode:
        params["season"] = season
        params["episode"] = episode
    if lang_codes:
        params["language"] = ",".join(filter(None, lang_codes))
    if setting("prefer_hi") == "true":
        params["hi"] = "true"

    try:
        r = requests.get(f"{WYZIE_BASE}/search", params=params, timeout=15,
                         headers={"User-Agent": "wyzie-kodi/1.0"})
    except requests.RequestException as e:
        log(f"request failed: {e}", xbmc.LOGERROR)
        notify("Network error contacting Wyzie")
        return

    if r.status_code == 401:
        notify("Invalid Wyzie API key — re-enter in settings", 8000)
        return
    if r.status_code in (402, 429):
        notify("Wyzie limit hit — upgrade at store.wyzie.io/pricing", 8000)
        return
    if not r.ok:
        log(f"http {r.status_code}: {r.text[:200]}", xbmc.LOGERROR)
        return

    data = r.json()
    if isinstance(data, dict):
        data = data.get("subtitles", [])

    for item in data:
        if not item.get("url"):
            continue
        label = item.get("display") or item.get("language", "Unknown")
        source = item.get("source", "wyzie")
        release = item.get("release") or item.get("fileName") or ""
        ai = " [AI]" if item.get("ai") else ""

        list_item = xbmcgui.ListItem(label=label, label2=f"{source} — {release}{ai}")
        list_item.setArt({"icon": "0", "thumb": item.get("flagUrl", "")})
        list_item.setProperty("sync", "false")
        list_item.setProperty("hearing_imp",
                              "true" if item.get("isHearingImpaired") else "false")

        url = "plugin://%s/?action=download&url=%s&format=%s" % (
            ADDON_ID,
            urllib.parse.quote(item["url"], safe=""),
            item.get("format", "srt"),
        )
        xbmcplugin.addDirectoryItem(handle=HANDLE, url=url,
                                    listitem=list_item, isFolder=False)

    xbmcplugin.endOfDirectory(HANDLE)


def download():
    url = PARAMS.get("url")
    fmt = PARAMS.get("format", "srt")
    if not url:
        return
    if not xbmcvfs.exists(PROFILE):
        xbmcvfs.mkdirs(PROFILE)

    dest = os.path.join(PROFILE, f"wyzie.{fmt}")
    try:
        r = requests.get(url, timeout=30,
                         headers={"User-Agent": "wyzie-kodi/1.0"})
        r.raise_for_status()
        with open(dest, "wb") as fh:
            fh.write(r.content)
    except Exception as e:
        log(f"download failed: {e}", xbmc.LOGERROR)
        notify("Download failed")
        return

    item = xbmcgui.ListItem(label=dest)
    xbmcplugin.addDirectoryItem(handle=HANDLE, url=dest,
                                listitem=item, isFolder=False)
    xbmcplugin.endOfDirectory(HANDLE)


_LANG_MAP = {
    "english": "en", "spanish": "es", "french": "fr", "german": "de",
    "italian": "it", "portuguese": "pt", "russian": "ru", "japanese": "ja",
    "korean": "ko", "chinese": "zh", "arabic": "ar", "turkish": "tr",
    "polish": "pl", "dutch": "nl", "swedish": "sv", "danish": "da",
    "finnish": "fi", "norwegian": "no", "czech": "cs", "greek": "el",
    "hebrew": "he", "hungarian": "hu", "indonesian": "id", "thai": "th",
    "vietnamese": "vi", "ukrainian": "uk", "romanian": "ro", "bulgarian": "bg",
}


def _lang_name_to_iso(name):
    return _LANG_MAP.get(name.strip().lower(), "")


def main():
    action = PARAMS.get("action")
    if action in ("search", "manualsearch"):
        search()
    elif action == "download":
        download()


if __name__ == "__main__":
    main()
