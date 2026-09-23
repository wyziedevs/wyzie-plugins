"""
Wyzie Subs subtitle service for Kodi.

Implements Kodi's subtitle plugin protocol:
  action=search: list candidates for the playing video
  action=manualsearch: search by a typed title (looked up on TMDB first)
  action=download: fetch a chosen entry

Get a free key at https://store.wyzie.io/redeem and set it in addon settings.
"""
import json
import os
import re
import sys
import time
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
USER_AGENT = "wyzie-kodi/1.0.2"

HANDLE = int(sys.argv[1])
PARAMS = dict(urllib.parse.parse_qsl(sys.argv[2].lstrip("?")))


def log(msg, lvl=xbmc.LOGINFO):
    xbmc.log(f"[wyzie] {msg}", lvl)


def setting(key):
    return ADDON.getSetting(key) or ""


def notify(msg, time_ms=5000):
    xbmcgui.Dialog().notification("Wyzie Subs", msg, time=time_ms)


def _json(r):
    try:
        body = r.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _no_results(r):
    """True when a 400 response is Wyzie's "No subtitles found" answer."""
    message = str(_json(r).get("message", "")) or (r.text or "")
    return "no subtitles found" in message.lower()


def _reset_time(reset_at):
    """reset_at (Unix seconds) as the device's local HH:MM, or midnight UTC."""
    try:
        return time.strftime("%H:%M", time.localtime(int(reset_at)))
    except (TypeError, ValueError, OverflowError, OSError):
        return "midnight UTC"


def _bare_url(url, fallback):
    """Show a link without its scheme, which reads better in a notification."""
    url = str(url or fallback)
    return re.sub(r"^https?://", "", url)


def refusal_message(r):
    """User-facing text for a refused Wyzie call, or None when it isn't one.

    Search and the /c/ download links answer with the same statuses and JSON
    fields, so both paths share this. A held key is recognised by its body (the
    "reinstate" link / "Key on hold" message), never by the bare 403, which also
    means an invalid key or a Pro-only source.
    """
    status = r.status_code
    body = _json(r)
    message = str(body.get("message") or "")
    low = message.lower()
    if status == 403:
        if body.get("reinstate") or "key on hold" in low:
            return "Key on hold: verify your site at store.wyzie.io/verify (or contact support)"
        if "free plan" in low:
            return "Those sources need a Pro key. Free keys get OpenSubtitles and IndexSubtitle."
        if "invalid api key" in low:
            return "Invalid Wyzie API key, re-enter it in the add-on settings"
        return "Wyzie refused the request: " + (message or "403")
    if status == 401:
        if "download link" in low:
            return "That download link expired, search again"
        return "No Wyzie API key sent, set one in the add-on settings"
    if status == 402:
        return "Wyzie Pro balance used up: top up at " + _bare_url(body.get("topup"), "store.wyzie.io/topup")
    if status == 429:
        return "Wyzie daily limit reached, resets at %s. Upgrade: %s" % (
            _reset_time(body.get("reset_at")), _bare_url(body.get("upgrade"), "store.wyzie.io/#plans"))
    if status == 503:
        return "Wyzie is briefly unavailable, try again in a moment"
    return None


def _info(label):
    return (xbmc.getInfoLabel(label) or "").strip()


def _imdb_id(value):
    value = (value or "").strip()
    return value if re.fullmatch(r"tt\d+", value) else None


def _tmdb_id(value):
    value = str(value or "").strip()
    return value if re.fullmatch(r"\d+", value) and int(value) > 0 else None


def _number(value):
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def _tvshow_unique_ids(dbid):
    """The library TV show's unique ids ({"imdb": ..., "tmdb": ...}), or {}."""
    if not _tmdb_id(dbid):  # a positive integer
        return {}
    query = {
        "jsonrpc": "2.0", "id": 1, "method": "VideoLibrary.GetTVShowDetails",
        "params": {"tvshowid": int(dbid), "properties": ["uniqueid"]},
    }
    try:
        result = json.loads(xbmc.executeJSONRPC(json.dumps(query)))
        return dict(result["result"]["tvshowdetails"].get("uniqueid") or {})
    except Exception as e:
        log(f"tvshow {dbid} unique ids unavailable: {e}", xbmc.LOGWARNING)
        return {}


def get_video_ids():
    """What to ask Wyzie for, from the item that is playing.

    Returns {"id", "season", "episode", "title", "year"}. "id" is an IMDb id
    (tt...) or a bare TMDB id (digits), which /search takes as is, or None.

    VideoPlayer.IMDBNumber is NOT necessarily an IMDb id: it is the item's
    default unique id, which for TMDB-scraped items is the TMDB id. So the typed
    ids are read explicitly, and digits are only ever sent as a TMDB id.

    For an episode the id must be the SHOW's (Wyzie searches by show + season +
    episode); the episode's own unique ids would name the wrong title.
    """
    season = _number(_info("VideoPlayer.Season"))
    episode = _number(_info("VideoPlayer.Episode"))
    if season is not None and episode is not None:
        # Library episode: ask the library for the show's ids.
        ids = _tvshow_unique_ids(_info("VideoPlayer.TvShowDBID"))
        imdb = _imdb_id(ids.get("imdb")) or _imdb_id(_info("VideoPlayer.UniqueID(tvshow.imdb)"))
        tmdb = _tmdb_id(ids.get("tmdb")) or _tmdb_id(_info("VideoPlayer.UniqueID(tvshow.tmdb)"))
        if not imdb and not tmdb and not ids:
            # Not from the library: add-ons that play episodes usually put the
            # show's IMDb id in IMDBNumber. Digits there are the episode's own
            # TMDB/TVDB id, so only an IMDb id is trusted.
            imdb = _imdb_id(_info("VideoPlayer.IMDBNumber"))
        return {"id": imdb or tmdb, "season": season, "episode": episode,
                "title": _info("VideoPlayer.TVShowTitle"), "year": None}

    imdb = _imdb_id(_info("VideoPlayer.UniqueID(imdb)"))
    tmdb = _tmdb_id(_info("VideoPlayer.UniqueID(tmdb)"))
    if not imdb and not tmdb:
        # Older Kodi without UniqueID(type): fall back to the default unique id.
        # For movies Kodi's stock scraper is TMDB, so digits are a TMDB id.
        default = _info("VideoPlayer.IMDBNumber")
        imdb = _imdb_id(default)
        tmdb = None if imdb else _tmdb_id(default)
    return {"id": imdb or tmdb, "season": None, "episode": None,
            "title": _info("VideoPlayer.OriginalTitle") or _info("VideoPlayer.Title"),
            "year": _info("VideoPlayer.Year") or None}


def _norm(text):
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def tmdb_search(query, media=None):
    """Wyzie's /api/tmdb/search (no key needed): up to 10 movie/tv results."""
    query = (query or "").strip()[:150]
    if len(query) < 2:
        return []
    try:
        r = requests.get(f"{WYZIE_BASE}/api/tmdb/search", params={"q": query}, timeout=15,
                         headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    except requests.RequestException as e:
        log(f"tmdb search failed: {e}", xbmc.LOGERROR)
        return []
    if not r.ok:
        log(f"tmdb search http {r.status_code}: {r.text[:200]}", xbmc.LOGERROR)
        return []
    results = _json(r).get("results") or []
    return [x for x in results if isinstance(x, dict) and _tmdb_id(x.get("id"))
            and (media is None or x.get("mediaType") == media)]


def pick_match(results, title, year=None):
    """Best result for a title: exact title and year first, TMDB's order after."""
    want = _norm(title)

    def rank(pair):
        index, item = pair
        names = {_norm(item.get("title")), _norm(item.get("originalTitle"))}
        exact = want in names
        year_score = 0
        if year and item.get("releaseYear"):
            try:
                diff = abs(int(item["releaseYear"]) - int(year))
                year_score = 2 if diff == 0 else (1 if diff == 1 else 0)
            except (TypeError, ValueError):
                pass
        return (year_score, exact, -index)

    if not results:
        return None
    return max(enumerate(results), key=rank)[1]


def lookup_tmdb(title, year=None, media=None):
    """TMDB id for a title (media "movie", "tv" or None for either), or None."""
    match = pick_match(tmdb_search(title, media), title, year)
    if not match:
        return None
    log(f"'{title}' ({year or 'any year'}) -> TMDB {match.get('mediaType')} {match.get('id')} "
        f"'{match.get('title')}' ({match.get('releaseYear')})")
    return match


_EPISODE_RE = re.compile(r"\bS(\d{1,2})\s*E(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b", re.I)
_PAREN_YEAR_RE = re.compile(r"[(\[]\s*((?:19|20)\d{2})\s*[)\]]")
_TRAILING_YEAR_RE = re.compile(r"\s((?:19|20)\d{2})\s*$")


def parse_search_string(text):
    """Split a typed search into (title, year, season, episode).

    Understands "Show S01E02" / "Show 1x02" and a year as "(2015)" or a trailing
    "2015". A bare trailing year is only a hint (see manual_target), since it can
    be part of the title ("Blade Runner 2049").
    """
    text = re.sub(r"[._]+", " ", text or "").strip()
    season = episode = None
    m = _EPISODE_RE.search(text)
    if m:
        season = int(m.group(1) or m.group(3))
        episode = int(m.group(2) or m.group(4))
        text = (text[:m.start()] + " " + text[m.end():]).strip()
    year = None
    bare_year = False
    m = _PAREN_YEAR_RE.search(text)
    if m:
        year = m.group(1)
        text = (text[:m.start()] + " " + text[m.end():]).strip()
    else:
        m = _TRAILING_YEAR_RE.search(text)
        if m:
            year, bare_year = m.group(1), True
    return re.sub(r"\s+", " ", text).strip(" -"), year, bare_year, season, episode


def manual_target(search_string, playing):
    """Resolve a typed search to {"id", "season", "episode"} via TMDB."""
    title, year, bare_year, season, episode = parse_search_string(search_string)
    if season is None and playing.get("season") is not None:
        # Searching by hand while an episode plays: it's for that episode.
        season, episode = playing["season"], playing["episode"]
    media = "tv" if season is not None else None
    match = None
    if bare_year:
        # Try the whole string first, so "Blade Runner 2049" stays a title...
        results = tmdb_search(title, media)
        full = [x for x in results if _norm(title) in (_norm(x.get("title")), _norm(x.get("originalTitle")))]
        match = full[0] if full else None
        if not match:
            # ...then treat the trailing number as the year ("The Martian 2015").
            title = title[:-4].strip()
    if not match:
        match = lookup_tmdb(title, year, media)
    if not match:
        return None
    if match.get("mediaType") == "tv" and season is None:
        return {"id": None, "error": "For a TV show, add the episode, e.g. \"%s S01E01\"" % match.get("title")}
    if match.get("mediaType") == "movie":
        season = episode = None
    return {"id": str(match["id"]), "season": season, "episode": episode}


def search(manual=False):
    key = setting("api_key")
    if not key:
        notify("Set your API key in addon settings (free at store.wyzie.io/redeem)", 8000)
        xbmcplugin.endOfDirectory(HANDLE)
        return

    playing = get_video_ids()
    typed = PARAMS.get("searchstring", "").strip() if manual else ""
    if typed:
        target = manual_target(typed, playing)
        if not target or not target.get("id"):
            notify((target or {}).get("error") or f"No movie or show found for \"{typed}\"")
            xbmcplugin.endOfDirectory(HANDLE)
            return
    else:
        target = playing
        if not target["id"] and target.get("title"):
            # No usable id on the item (e.g. a plain file): look the title up.
            media = "tv" if target["season"] is not None else "movie"
            match = lookup_tmdb(target["title"], target.get("year"), media)
            target = dict(target, id=str(match["id"]) if match else None)
        if not target["id"]:
            notify("Couldn't identify this video. Use Manual search to type its title.")
            xbmcplugin.endOfDirectory(HANDLE)
            return

    lang_codes = []
    for name in PARAMS.get("languages", "").split(","):
        name = name.strip()
        if not name:
            continue
        # Kodi gives language *names* (e.g. "English"); map common ones
        lang_codes.append(_lang_name_to_iso(name))

    # source=all gives every key everything its tier allows (free: OpenSubtitles
    # and IndexSubtitle; Pro: every provider). No "hi" parameter: on Wyzie it is
    # a hard filter that drops every non-SDH subtitle, so "prefer" is done here
    # by listing hearing-impaired results first instead.
    params = {"id": target["id"], "key": key, "format": "srt", "source": "all"}
    if target.get("season") is not None and target.get("episode") is not None:
        params["season"] = target["season"]
        params["episode"] = target["episode"]
    if lang_codes:
        params["language"] = ",".join(sorted(set(filter(None, lang_codes))))

    try:
        r = requests.get(f"{WYZIE_BASE}/search", params=params, timeout=15,
                         headers={"User-Agent": USER_AGENT})
    except requests.RequestException as e:
        log(f"request failed: {e}", xbmc.LOGERROR)
        notify("Network error contacting Wyzie")
        xbmcplugin.endOfDirectory(HANDLE)
        return

    if r.status_code == 400 and _no_results(r):
        # Wyzie answers 400 "No subtitles found" rather than an empty list.
        xbmcplugin.endOfDirectory(HANDLE)
        return
    if not r.ok:
        msg = refusal_message(r)
        log(f"http {r.status_code}: {r.text[:200]}", xbmc.LOGERROR)
        if msg:
            notify(msg, 8000)
        xbmcplugin.endOfDirectory(HANDLE)
        return

    data = r.json()
    if isinstance(data, dict):
        data = data.get("subtitles", [])
    data = [item for item in data if isinstance(item, dict) and item.get("url")]
    if setting("prefer_hi") == "true":
        # Stable sort: hearing-impaired first, API order otherwise kept.
        data.sort(key=lambda item: not item.get("isHearingImpaired"))

    for item in data:
        label = item.get("display") or item.get("language", "Unknown")
        source = item.get("source", "wyzie")
        release = item.get("release") or item.get("fileName") or ""
        ai = " [AI]" if item.get("ai") else ""

        list_item = xbmcgui.ListItem(label=label, label2=f"{source} - {release}{ai}")
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
        # Each download link costs one request from the key, and is refused
        # with the same statuses as /search when the key can't pay.
        r = requests.get(url, timeout=30, headers={"User-Agent": USER_AGENT})
    except requests.RequestException as e:
        log(f"download failed: {e}", xbmc.LOGERROR)
        notify("Download failed")
        return
    if not r.ok:
        log(f"download http {r.status_code}: {r.text[:200]}", xbmc.LOGERROR)
        notify(refusal_message(r) or "Download failed", 8000)
        return
    try:
        with open(dest, "wb") as fh:
            fh.write(r.content)
    except OSError as e:
        log(f"saving subtitle failed: {e}", xbmc.LOGERROR)
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
    if action == "search":
        search()
    elif action == "manualsearch":
        search(manual=True)
    elif action == "download":
        download()


if __name__ == "__main__":
    main()
