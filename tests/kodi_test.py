#!/usr/bin/env python3
"""
Test the Kodi subtitle service WITHOUT installing Kodi.

service.py talks to the Kodi runtime via the xbmc/xbmcgui/xbmcplugin/xbmcvfs/
xbmcaddon modules, which only exist inside Kodi. We stub that surface, feed it
fake InfoLabels + settings, and drive the real search()/download() logic
against the live Wyzie API.

This covers everything except Kodi's own UI rendering: language mapping, id
extraction (IMDb / TMDB / the show's ids for episodes), manual title search,
refusal messages, request building, response -> ListItem mapping, and file
download. The pure checks run without a key; the live ones need WYZIE_KEY.
For the final "does it actually show up in the player" check, see the manual
Kodi steps in tests/README.md (the one plugin worth installing the app for).

Run from the repo root:
    WYZIE_KEY=wyzie-xxxx python tests/kodi_test.py
    (PowerShell)  $env:WYZIE_KEY="wyzie-..."; python tests/kodi_test.py
"""
import os
import sys
import types
import tempfile
import importlib.util

KEY = os.environ.get("WYZIE_KEY")
HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_PATH = os.path.join(HERE, "..", "kodi", "service.py")
PROFILE_DIR = tempfile.mkdtemp(prefix="wyzie-kodi-")

# Controllable state the stubs read from.
INFO = {}        # InfoLabel name -> value
SETTINGS = {}    # setting key -> value
ADDED = []       # captured addDirectoryItem calls
TVSHOWS = {}     # library tvshowid -> uniqueid dict (for the JSON-RPC stub)

def install_stubs():
    xbmc = types.ModuleType("xbmc")
    xbmc.LOGINFO = 1; xbmc.LOGWARNING = 2; xbmc.LOGERROR = 4
    xbmc.getInfoLabel = lambda name: INFO.get(name, "")
    xbmc.log = lambda msg, lvl=1: None

    def execute_jsonrpc(raw):
        import json
        req = json.loads(raw)
        tvshowid = req.get("params", {}).get("tvshowid")
        if req.get("method") == "VideoLibrary.GetTVShowDetails" and tvshowid in TVSHOWS:
            return json.dumps({"result": {"tvshowdetails": {"uniqueid": TVSHOWS[tvshowid]}}})
        return json.dumps({"error": {"code": -32602, "message": "Invalid params."}})
    xbmc.executeJSONRPC = execute_jsonrpc
    sys.modules["xbmc"] = xbmc

    xbmcaddon = types.ModuleType("xbmcaddon")
    class Addon:
        def getAddonInfo(self, k):
            return {"id": "service.subtitles.wyzie", "profile": PROFILE_DIR}.get(k, "")
        def getSetting(self, k):
            return SETTINGS.get(k, "")
    xbmcaddon.Addon = Addon
    sys.modules["xbmcaddon"] = xbmcaddon

    xbmcgui = types.ModuleType("xbmcgui")
    class ListItem:
        def __init__(self, label="", label2=""):
            self.label = label; self.label2 = label2; self.props = {}; self.art = {}
        def setArt(self, d): self.art.update(d)
        def setProperty(self, k, v): self.props[k] = v
    class Dialog:
        def notification(self, *a, **k): pass
    xbmcgui.ListItem = ListItem
    xbmcgui.Dialog = Dialog
    sys.modules["xbmcgui"] = xbmcgui

    xbmcplugin = types.ModuleType("xbmcplugin")
    xbmcplugin.addDirectoryItem = lambda handle, url, listitem, isFolder: ADDED.append(
        {"handle": handle, "url": url, "listitem": listitem, "isFolder": isFolder})
    xbmcplugin.endOfDirectory = lambda handle: None
    sys.modules["xbmcplugin"] = xbmcplugin

    xbmcvfs = types.ModuleType("xbmcvfs")
    xbmcvfs.translatePath = lambda p: p
    xbmcvfs.exists = lambda p: os.path.exists(p)
    xbmcvfs.mkdirs = lambda p: (os.makedirs(p, exist_ok=True) or True)
    sys.modules["xbmcvfs"] = xbmcvfs

def load_service():
    # service.py reads sys.argv[1] (handle) and sys.argv[2] (query) at import.
    sys.argv = ["service.py", "1", "?action=noop"]
    spec = importlib.util.spec_from_file_location("wyzie_kodi", SERVICE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

PASS = FAIL = 0
def ok(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  [PASS] {name}")
    else:
        FAIL += 1; print(f"  [FAIL] {name}" + (f" - {detail}" if detail else ""))

def offline_checks(kodi):
    """Pure logic: no network, no key needed."""
    # 1. Language name -> ISO mapping
    print("Language mapping:")
    ok("English -> en", kodi._lang_name_to_iso("English") == "en")
    ok("Spanish -> es", kodi._lang_name_to_iso("spanish") == "es")
    ok("unknown -> ''", kodi._lang_name_to_iso("Klingon") == "")

    # 2. Which id gets sent. IMDBNumber is the DEFAULT unique id (TMDB for
    # TMDB-scraped items), so digits must never become "tt<digits>".
    print("\nVideo id extraction:")
    INFO.clear(); INFO.update({"VideoPlayer.UniqueID(imdb)": "tt0816692", "VideoPlayer.UniqueID(tmdb)": "157336"})
    v = kodi.get_video_ids()
    ok("movie: prefers UniqueID(imdb)", v["id"] == "tt0816692" and v["season"] is None, str(v))
    INFO.clear(); INFO.update({"VideoPlayer.UniqueID(tmdb)": "157336", "VideoPlayer.IMDBNumber": "157336"})
    v = kodi.get_video_ids()
    ok("movie: TMDB id sent as bare digits", v["id"] == "157336", str(v))
    INFO.clear(); INFO.update({"VideoPlayer.IMDBNumber": "157336"})
    v = kodi.get_video_ids()
    ok("movie: digit IMDBNumber is a TMDB id, not tt<digits>", v["id"] == "157336", str(v))
    INFO.clear(); INFO.update({"VideoPlayer.IMDBNumber": "tt0816692"})
    ok("movie: tt IMDBNumber still works", kodi.get_video_ids()["id"] == "tt0816692")

    TVSHOWS.clear(); TVSHOWS[7] = {"imdb": "tt0944947", "tmdb": "1399", "tvdb": "121361"}
    INFO.clear(); INFO.update({"VideoPlayer.TvShowDBID": "7", "VideoPlayer.Season": "1", "VideoPlayer.Episode": "2",
                               # the EPISODE's own ids, which must not be used:
                               "VideoPlayer.UniqueID(imdb)": "tt1668746", "VideoPlayer.IMDBNumber": "63057"})
    v = kodi.get_video_ids()
    ok("episode: uses the show's ids from the library", (v["id"], v["season"], v["episode"]) == ("tt0944947", 1, 2), str(v))
    TVSHOWS[8] = {"tmdb": "1399"}
    INFO["VideoPlayer.TvShowDBID"] = "8"
    ok("episode: show TMDB id when no IMDb id", kodi.get_video_ids()["id"] == "1399")
    INFO.clear(); INFO.update({"VideoPlayer.Season": "1", "VideoPlayer.Episode": "2",
                               "VideoPlayer.UniqueID(tvshow.tmdb)": "1399", "VideoPlayer.IMDBNumber": "63057"})
    ok("episode (add-on item): tvshow.tmdb unique id", kodi.get_video_ids()["id"] == "1399")
    INFO.clear(); INFO.update({"VideoPlayer.Season": "1", "VideoPlayer.Episode": "2", "VideoPlayer.IMDBNumber": "63057"})
    ok("episode: digit IMDBNumber (the episode's id) is ignored", kodi.get_video_ids()["id"] is None)

    # 3. Manual search parsing and TMDB result picking
    print("\nManual search parsing:")
    ok("title + (year)", kodi.parse_search_string("The Martian (2015)") == ("The Martian", "2015", False, None, None))
    t, y, bare, s, e = kodi.parse_search_string("Severance S01E02")
    ok("show + SxxEyy", (t, y, s, e) == ("Severance", None, 1, 2))
    ok("show + 1x02", kodi.parse_search_string("Severance 1x02")[3:] == (1, 2))
    ok("bare trailing year is only a hint",
       kodi.parse_search_string("Blade Runner 2049")[:3] == ("Blade Runner 2049", "2049", True))
    results = [
        {"id": 1, "mediaType": "movie", "title": "The Martian", "releaseYear": "1995"},
        {"id": 286217, "mediaType": "movie", "title": "The Martian", "releaseYear": "2015"},
        {"id": 3, "mediaType": "movie", "title": "The Martian Chronicles", "releaseYear": "2015"},
    ]
    ok("picks exact title + year", kodi.pick_match(results, "The Martian", "2015")["id"] == 286217)
    ok("no year: keeps TMDB order among exact titles", kodi.pick_match(results, "The Martian")["id"] == 1)

    # 4. Refusal messages come from the body, not the bare status
    print("\nRefusal messages:")

    class R:
        def __init__(self, status, body):
            self.status_code, self._b = status, body

        def json(self):
            return self._b

    held = kodi.refusal_message(R(403, {"message": "Key on hold", "reinstate": "https://store.wyzie.io/verify"}))
    ok("held key is not 'invalid'", "on hold" in held and "invalid" not in held.lower(), held)
    ok("free plan", "Pro key" in kodi.refusal_message(R(403, {"message": "Provider not available on free plan"})))
    ok("invalid key", "Invalid" in kodi.refusal_message(R(403, {"message": "Invalid API key"})))
    ok("402 top-up", "topup" in kodi.refusal_message(R(402, {"topup": "https://store.wyzie.io/topup"})))
    ok("429 daily limit", "daily limit" in kodi.refusal_message(R(429, {"reset_at": 1790000000})))
    ok("expired download link", "expired" in kodi.refusal_message(R(401, {"message": "Download link invalid or expired"})))


def main():
    install_stubs()
    kodi = load_service()
    offline_checks(kodi)
    if not KEY:
        print(f"\n{'='*40}\n{PASS} passed, {FAIL} failed (offline only; set WYZIE_KEY for the live tests)")
        sys.exit(1 if FAIL else 2)

    # 5. search() — movie, builds request + maps results to ListItems
    print("\nsearch() — movie:")
    ADDED.clear()
    SETTINGS.clear(); SETTINGS.update({"api_key": KEY})
    INFO.clear(); INFO.update({"VideoPlayer.UniqueID(imdb)": "tt0816692"})
    kodi.PARAMS = {"action": "search", "languages": "English"}
    kodi.HANDLE = 1
    kodi.search()
    ok("added >=1 directory item", len(ADDED) >= 1, f"got {len(ADDED)}")
    if ADDED:
        url = ADDED[0]["url"]
        ok("item url is a plugin download link",
           url.startswith("plugin://") and "action=download" in url and "url=" in url, url[:80])

    # 6. search() — series (library episode: the show's id via JSON-RPC)
    print("\nsearch() — series:")
    ADDED.clear()
    TVSHOWS.clear(); TVSHOWS[7] = {"imdb": "tt0944947"}
    INFO.clear(); INFO.update({"VideoPlayer.TvShowDBID": "7", "VideoPlayer.Season": "1", "VideoPlayer.Episode": "1"})
    kodi.PARAMS = {"action": "search", "languages": "English"}
    kodi.search()
    ok("added >=1 item for S1E1", len(ADDED) >= 1, f"got {len(ADDED)}")
    series_items = list(ADDED)

    # 7. manual search by title (TMDB lookup, then search by TMDB id)
    print("\nsearch(manual=True) — typed title:")
    ADDED.clear()
    INFO.clear()
    kodi.PARAMS = {"action": "manualsearch", "searchstring": "Interstellar 2014", "languages": "English"}
    kodi.search(manual=True)
    ok("manual title search found subtitles", len(ADDED) >= 1, f"got {len(ADDED)}")

    # 8. download() — fetch a real subtitle file to the profile dir
    print("\ndownload():")
    if series_items:
        # pull the real download URL out of the plugin:// link from step 6
        import urllib.parse
        q = urllib.parse.urlparse(series_items[0]["url"]).query
        real_url = urllib.parse.parse_qs(q)["url"][0]
        ADDED.clear()
        kodi.PARAMS = {"action": "download", "url": real_url, "format": "srt"}
        kodi.download()
        ok("download added the saved file path", len(ADDED) >= 1, f"got {len(ADDED)}")
        if ADDED:
            dest = ADDED[0]["url"]
            ok("file exists on disk", os.path.exists(dest), dest)
            ok("file has content", os.path.exists(dest) and os.path.getsize(dest) > 50)

    # 9. Missing key — should not crash, adds nothing
    print("\nsearch() — no api key:")
    ADDED.clear()
    SETTINGS.clear()
    INFO.clear(); INFO.update({"VideoPlayer.UniqueID(imdb)": "tt0816692"})
    kodi.PARAMS = {"action": "search"}
    kodi.search()
    ok("no items added without key", len(ADDED) == 0, f"got {len(ADDED)}")

    print(f"\n{'='*40}\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
