#!/usr/bin/env python3
"""
Test the Kodi subtitle service WITHOUT installing Kodi.

service.py talks to the Kodi runtime via the xbmc/xbmcgui/xbmcplugin/xbmcvfs/
xbmcaddon modules, which only exist inside Kodi. We stub that surface, feed it
fake InfoLabels + settings, and drive the real search()/download() logic
against the live Wyzie API.

This covers everything except Kodi's own UI rendering: language mapping, IMDB
extraction, request building, response -> ListItem mapping, and file download.
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

def install_stubs():
    xbmc = types.ModuleType("xbmc")
    xbmc.LOGINFO = 1; xbmc.LOGERROR = 4
    xbmc.getInfoLabel = lambda name: INFO.get(name, "")
    xbmc.log = lambda msg, lvl=1: None
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

def main():
    if not KEY:
        print("ERROR: set WYZIE_KEY"); sys.exit(2)
    install_stubs()
    kodi = load_service()

    # 1. Language name -> ISO mapping (pure)
    print("Language mapping:")
    ok("English -> en", kodi._lang_name_to_iso("English") == "en")
    ok("Spanish -> es", kodi._lang_name_to_iso("spanish") == "es")
    ok("unknown -> ''", kodi._lang_name_to_iso("Klingon") == "")

    # 2. IMDB extraction from InfoLabels
    print("\nIMDB / episode extraction:")
    INFO.clear(); INFO.update({"VideoPlayer.IMDBNumber": "tt0816692"})
    imdb, s, e = kodi.get_imdb_and_episode()
    ok("reads tt id", imdb == "tt0816692", str(imdb))
    INFO.clear(); INFO.update({"VideoPlayer.IMDBNumber": "0816692"})
    imdb2, _, _ = kodi.get_imdb_and_episode()
    ok("prefixes bare digits with tt", imdb2 == "tt0816692", str(imdb2))

    # 3. search() — movie, builds request + maps results to ListItems
    print("\nsearch() — movie:")
    ADDED.clear()
    SETTINGS.clear(); SETTINGS.update({"api_key": KEY})
    INFO.clear(); INFO.update({"VideoPlayer.IMDBNumber": "tt0816692",
                               "VideoPlayer.Season": "", "VideoPlayer.Episode": ""})
    kodi.PARAMS = {"action": "search", "languages": "English"}
    kodi.HANDLE = 1
    kodi.search()
    ok("added >=1 directory item", len(ADDED) >= 1, f"got {len(ADDED)}")
    if ADDED:
        url = ADDED[0]["url"]
        ok("item url is a plugin download link",
           url.startswith("plugin://") and "action=download" in url and "url=" in url, url[:80])

    # 4. search() — series
    print("\nsearch() — series:")
    ADDED.clear()
    INFO.clear(); INFO.update({"VideoPlayer.IMDBNumber": "tt0944947",
                               "VideoPlayer.Season": "1", "VideoPlayer.Episode": "1"})
    kodi.PARAMS = {"action": "search", "languages": "English"}
    kodi.search()
    ok("added >=1 item for S1E1", len(ADDED) >= 1, f"got {len(ADDED)}")

    # 5. download() — fetch a real subtitle file to the profile dir
    print("\ndownload():")
    if ADDED:
        # pull the real download URL out of the plugin:// link from step 4
        import urllib.parse
        q = urllib.parse.urlparse(ADDED[0]["url"]).query
        real_url = urllib.parse.parse_qs(q)["url"][0]
        ADDED.clear()
        kodi.PARAMS = {"action": "download", "url": real_url, "format": "srt"}
        kodi.download()
        ok("download added the saved file path", len(ADDED) >= 1, f"got {len(ADDED)}")
        if ADDED:
            dest = ADDED[0]["url"]
            ok("file exists on disk", os.path.exists(dest), dest)
            ok("file has content", os.path.exists(dest) and os.path.getsize(dest) > 50)

    # 6. Missing key — should not crash, adds nothing
    print("\nsearch() — no api key:")
    ADDED.clear()
    SETTINGS.clear()
    INFO.clear(); INFO.update({"VideoPlayer.IMDBNumber": "tt0816692"})
    kodi.PARAMS = {"action": "search"}
    kodi.search()
    ok("no items added without key", len(ADDED) == 0, f"got {len(ADDED)}")

    print(f"\n{'='*40}\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
