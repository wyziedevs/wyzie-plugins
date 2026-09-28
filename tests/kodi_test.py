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
NOTES = []       # captured notifications
ENDED = []       # captured endOfDirectory calls
# What the stubbed xbmc.convertLanguage(name, ISO_639_1) knows. Real Kodi
# answers plain "pt" for Portuguese (Brazil), which the add-on must not use.
KODI_ISO = {"Northern Sami": "se", "Portuguese (Brazil)": "pt", "English": "en"}

def install_stubs():
    xbmc = types.ModuleType("xbmc")
    xbmc.LOGINFO = 1; xbmc.LOGWARNING = 2; xbmc.LOGERROR = 4
    xbmc.ISO_639_1 = 0; xbmc.ISO_639_2 = 1; xbmc.ENGLISH_NAME = 2
    xbmc.getInfoLabel = lambda name: INFO.get(name, "")
    xbmc.log = lambda msg, lvl=1: None
    xbmc.convertLanguage = lambda name, fmt: KODI_ISO.get(name, "") if fmt == xbmc.ISO_639_1 else ""

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
        def notification(self, heading, message, *a, **k): NOTES.append(message)
    xbmcgui.ListItem = ListItem
    xbmcgui.Dialog = Dialog
    sys.modules["xbmcgui"] = xbmcgui

    xbmcplugin = types.ModuleType("xbmcplugin")
    xbmcplugin.addDirectoryItem = lambda handle, url, listitem, isFolder: ADDED.append(
        {"handle": handle, "url": url, "listitem": listitem, "isFolder": isFolder})
    xbmcplugin.endOfDirectory = lambda handle, *a, **k: ENDED.append(handle)
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
    ok("Portuguese (Brazil) -> pb (not Kodi's plain pt)", kodi._lang_name_to_iso("Portuguese (Brazil)") == "pb")
    ok("Portuguese-Brazil -> pb", kodi._lang_name_to_iso("Portuguese-Brazil") == "pb")
    ok("Chinese (Traditional) -> zt", kodi._lang_name_to_iso("Chinese (Traditional)") == "zt")
    ok("beyond the old 34 names (Slovenian, Tagalog, Welsh, Amharic)",
       [kodi._lang_name_to_iso(n) for n in ("Slovenian", "Tagalog", "Welsh", "Amharic")] == ["sl", "tl", "cy", "am"])
    ok("xbmc.convertLanguage for a name the table lacks", kodi._lang_name_to_iso("Northern Sami") == "se")
    ok("codes too (eng, pt-BR, zh_TW)", [kodi._lang_name_to_iso(c) for c in ("eng", "pt-BR", "zh_TW")] == ["en", "pb", "zt"])
    ok("Kodi 22 'original' / 'default' skipped",
       kodi._lang_name_to_iso("original") == "" and kodi._lang_name_to_iso("Default") == "")

    print("\nAI rows: the exact language (offline):")
    ai_rows = [{"language": c, "display": d} for c, d in (
        ("en-AU", "English (Australia)"), ("en-US", "English (United States)"), ("en", "English"),
        ("es-AR", "Spanish (Argentina)"), ("es", "Spanish"), ("pt-BR", "Portuguese (Brazil)"),
        ("pt", "Portuguese"), ("fr-CA", "French (Canada)"), ("zh-TW", "Chinese (Taiwan)"), ("zh", "Chinese"))]
    picked = [r["display"] for r in kodi.pick_ai_rows(ai_rows, ["en", "es", "pt", "pb", "zt", "fr"])]
    ok("en/es/pt/pb/zt/fr -> English, Spanish, Portuguese, Portuguese (Brazil), Chinese (Taiwan), French (Canada)",
       picked == ["English", "Spanish", "Portuguese", "Portuguese (Brazil)", "Chinese (Taiwan)", "French (Canada)"], picked)
    ok("no languages: one per language, the plain one",
       [r["display"] for r in kodi.pick_ai_rows(ai_rows, [])] == ["English", "Spanish", "Portuguese", "French (Canada)", "Chinese"])

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
    ok("paid feature", "Pro key" in kodi.refusal_message(R(403, {"message": "Paid feature"})))

    # 5. Release matching, options and dual entries
    print("\nRelease matching + Pro options (offline):")
    import urllib.parse as up
    playing = "Breaking.Bad.S01E01.1080p.BluRay.x264-DEMAND.mkv"
    good = {"release": "Breaking.Bad.S01E01.1080p.BluRay.x264-DEMAND"}
    meh = {"release": "Breaking.Bad.S01E01.720p.HDTV.x264-CTU"}
    ok("same group + tokens scores high", kodi.release_score(good, playing) >= 8, kodi.release_score(good, playing))
    ok("other release scores low", kodi.release_score(meh, playing) < 5, kodi.release_score(meh, playing))
    ok("no playing file scores 0", kodi.release_score(good, "") == 0)

    def q(url):
        return {k: v[0] for k, v in up.parse_qs(up.urlsplit(url).query).items()}
    c_url = "https://sub.wyzie.io/c/abc/id/1?format=srt&tok=t&id=tt0903747"
    data = [
        dict(good, url=c_url, language="en", display="English", source="charlie", format="srt", _score=9),
        {"url": c_url.replace("/1?", "/2?"), "language": "es", "display": "Spanish", "source": "charlie", "format": "srt"},
        {"url": "https://sub.wyzie.io/translate?id=tt0903747&target=German&tk=x", "language": "de",
         "display": "German", "source": "ai", "ai": True, "format": "srt"},
        {"url": c_url.replace("/1?", "/3?"), "language": "en", "display": "English", "source": "charlie", "format": "idx"},
    ]
    entries = kodi.build_entries(data, {"sdh": "strip", "plain": "1"}, "es")
    duals = [e for e in entries if "dual" in q(e["url"])]
    ok("one dual copy (en text sub only)", len(duals) == 1, [e["label2"] for e in entries])
    ok("dual copy listed first", entries[0] is duals[0] if duals else False)
    ok("dual copy labelled [+ Spanish]", duals and duals[0]["label2"].startswith("[+ Spanish]"), duals and duals[0]["label2"])
    ok("single-language rows kept", len(entries) == len(data) + 1)
    ok("options on /c/ text subs", all(q(e["url"]).get("sdh") == "strip" for e in entries[:3] if "/c/" in e["url"]))
    ok("AI and image subs untouched", "sdh" not in q(entries[3]["url"]) and "sdh" not in q(entries[4]["url"]))
    ok("existing tok/id kept", q(entries[0]["url"]).get("tok") == "t" and q(entries[0]["url"]).get("id") == "tt0903747")
    ok("strong release match marked synced", entries[1]["sync"] is True and entries[2]["sync"] is False)
    ok("dual setting name -> code", (SETTINGS.clear() or SETTINGS.update({"dual_lang": "Spanish"}) or kodi.dual_language()) == "es")
    SETTINGS.clear(); SETTINGS.update({"dual_lang": "Off"})
    ok("dual Off -> no dual", kodi.dual_language() == "")
    stripped = q(kodi._without_pro_options(c_url + "&dual=es&sdh=strip&clean=1&plain=1"))
    ok("free-key retry drops only Pro options", not ({"dual", "sdh", "clean"} & set(stripped)) and stripped.get("plain") == "1")
    mixed = [dict(data[0], language=l, url=c_url.replace("/1?", "/%d?" % i)) for i, l in enumerate(["hu", "pl", "en", "pb"], 10)]
    only = lambda langs, dual: [q(e["url"]).get("dual") and e["url"].split("/id/")[1][:2]
                                for e in kodi.build_entries(mixed, {}, dual, langs) if "dual" in q(e["url"])]
    ok("dual copies only in the searched languages (pl)", only(["pl", "es"], "es") == ["11"], only(["pl", "es"], "es"))
    ok("no languages: dual copies of English rows only", only([], "es") == ["12"], only([], "es"))
    ok("dual pt: no copy of a pb (Brazilian) row", only(["pb", "en"], "pt") == ["12"], only(["pb", "en"], "pt"))
    SETTINGS.clear()

    # 6. search() + download() with /search and the download stubbed
    print("\nsearch() / download() against canned responses (offline):")

    class Resp:
        def __init__(self, status, body, content=b""):
            self.status_code, self._b, self.content = status, body, content
            self.ok, self.text, self.headers = 200 <= status < 300, str(body), {}

        def json(self):
            return self._b

    sent = []
    rows = [
        {"url": c_url, "language": "en", "display": "English", "source": "charlie", "format": "srt"},
        {"url": c_url.replace("/1?", "/2?"), "language": "pb", "display": "Portuguese (Brazil)", "source": "charlie", "format": "srt"},
    ] + [{"url": "https://sub.wyzie.io/translate?id=tt0816692&tk=x&target=" + d.replace(" ", "%20"),
          "language": r["language"], "display": d, "source": "ai", "ai": True, "format": "srt"}
         for r, d in ((r, r["display"]) for r in ai_rows)]
    real_get = kodi.requests.get

    def fake_get(url, params=None, **kw):
        sent.append(dict(params or {}, _url=url))
        return Resp(200, rows)
    kodi.requests.get = fake_get
    try:
        SETTINGS.clear(); SETTINGS.update({"api_key": "wyzie-" + "0" * 32, "ai_translate": "true"})
        INFO.clear(); INFO.update({"VideoPlayer.UniqueID(imdb)": "tt0816692"})
        ADDED.clear(); sent.clear()
        kodi.PARAMS = {"action": "search", "languages": "original,English,Portuguese (Brazil),Klingon,default"}
        kodi.search()
        ok("language= is en,pb ('original'/'default'/unknown skipped)", sent and sent[0].get("language") == "en,pb", sent and sent[0].get("language"))
        labels = [a["listitem"].label for a in ADDED if "[AI]" in a["listitem"].label2]
        ok("AI rows: English and Portuguese (Brazil), not a variant", labels == ["English", "Portuguese (Brazil)"], labels)
        ADDED.clear(); sent.clear()
        kodi.PARAMS = {"action": "search", "languages": "original,default"}
        kodi.search()
        ok("no language at all: no empty language= param", sent and "language" not in sent[0], sent and sorted(sent[0]))

        def busy(url, **kw):
            return Resp(503, {"code": 503, "message": "Too many translations", "details": "Server is busy."})
        kodi.requests.get = busy
        ADDED.clear(); NOTES.clear(); ENDED.clear()
        kodi.PARAMS = {"action": "download", "url": rows[-1]["url"], "format": "srt"}
        kodi.download()
        ok("busy AI translation (503): a message, no file, no crash",
           not ADDED and NOTES and "AI translation is busy" in NOTES[-1], NOTES)
        ok("download ends the directory even when it fails", ENDED == [kodi.HANDLE], ENDED)
        ok("503 Translation unavailable -> same message",
           "AI translation is busy" in kodi.refusal_message(Resp(503, {"message": "Translation unavailable"})))
        ok("plain 503 keeps the generic message",
           "briefly unavailable" in kodi.refusal_message(Resp(503, {"message": "Service temporarily unavailable"})))
    finally:
        kodi.requests.get = real_get
        SETTINGS.clear()


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

        # A second download replaces the first file instead of reusing its name.
        ADDED.clear()
        kodi.download()
        if ADDED and os.path.exists(ADDED[0]["url"]):
            ok("new file per download, old one cleared",
               ADDED[0]["url"] != dest and not os.path.exists(dest), (dest, ADDED[0]["url"]))

    # 8b. Pro options live: dual Spanish copies, downloaded with both languages
    print("\nsearch() + download() — dual subtitles (live):")
    ADDED.clear()
    SETTINGS.clear(); SETTINGS.update({"api_key": KEY, "dual_lang": "Spanish", "strip_sdh": "true"})
    TVSHOWS.clear(); TVSHOWS[9] = {"imdb": "tt0903747"}
    INFO.clear(); INFO.update({"VideoPlayer.TvShowDBID": "9", "VideoPlayer.Season": "1", "VideoPlayer.Episode": "1"})
    kodi.PARAMS = {"action": "search", "languages": "English"}
    kodi.search()
    import urllib.parse
    dual_items = [a for a in ADDED if a["listitem"].label2.startswith("[+ Spanish]")]
    ok("dual copies listed", 1 <= len(dual_items) <= kodi.DUAL_MAX, f"got {len(dual_items)} of {len(ADDED)}")
    if dual_items:
        real_url = urllib.parse.parse_qs(urllib.parse.urlparse(dual_items[0]["url"]).query)["url"][0]
        ok("dual link carries dual=es + sdh", "dual=es" in real_url and "sdh=strip" in real_url)
        seen = {}
        real_get = kodi.requests.get
        def recording_get(url, **kw):
            r = real_get(url, **kw)
            seen.setdefault("dual", r.headers.get("X-Dual"))
            return r
        kodi.requests.get = recording_get
        ADDED.clear()
        kodi.PARAMS = {"action": "download", "url": real_url, "format": "srt"}
        kodi.download()
        kodi.requests.get = real_get
        ok("dual download merged Spanish (X-Dual: es)", seen.get("dual") == "es", seen.get("dual"))
        ok("dual subtitle saved", len(ADDED) == 1 and os.path.getsize(ADDED[0]["url"]) > 1000)

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
