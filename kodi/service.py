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
WYZIE_HOST = urllib.parse.urlsplit(WYZIE_BASE).hostname
USER_AGENT = "wyzie-kodi/1.1.1"
# Subtitle formats a download may be saved as; anything else is saved as .srt.
SUB_FORMATS = ("srt", "vtt", "ass", "ssa", "sub")
# Download options Wyzie applies to a /c/ link. The Pro ones are refused
# (403 "Paid feature", not charged) on a free key; download() then retries
# without them.
PRO_OPTIONS = ("dual", "sdh", "clean")
TEXT_FORMATS = ("srt", "vtt", "webvtt", "ass", "ssa", "sub", "ttml", "dfxp", "txt")
# How many bilingual copies to list (the best-ranked subtitles).
DUAL_MAX = 8

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


def _redact(url):
    """A URL fit for the log: the API key and download token masked."""
    return re.sub(r"(?i)([?&](?:key|api_key|tok)=)[^&#]*", r"\1***", str(url or ""))


def _sub_format(value):
    """The subtitle format as a safe file extension: one of SUB_FORMATS, else srt."""
    fmt = str(value or "").strip().lower()
    return fmt if fmt in SUB_FORMATS else "srt"


def _wyzie_url(url):
    """True for an https link on the Wyzie host, the only place downloads come from."""
    url = str(url or "")
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (parts.scheme == "https" and parts.hostname == WYZIE_HOST and port in (None, 443)
            and "@" not in parts.netloc and "\\" not in url)


def _with_params(url, params):
    """url with each of params set in its query string (replacing any old value)."""
    parts = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True) if k not in params]
    query += [(k, str(v)) for k, v in params.items() if v not in (None, "")]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def _without_pro_options(url):
    parts = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
             if k.lower() not in PRO_OPTIONS]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def _is_ai(item):
    return bool(item.get("ai")) or item.get("source") == "ai"


def _takes_options(item):
    """A /c/ download of a text subtitle: the only kind Wyzie's options apply to."""
    url = str(item.get("url") or "")
    fmt = str(item.get("format") or "srt").lower()
    return (not _is_ai(item) and urllib.parse.urlsplit(url).path.startswith("/c/") and fmt in TEXT_FORMATS)


# Release-name tokens worth matching on (quality, source, codec, HDR, audio),
# the same list the Stremio addon uses. A subtitle whose release shares these
# with the playing file is far more likely to be timed for it.
_RELEASE_TOKEN_RE = re.compile(
    r"\b(?:2160p|1080p|720p|480p|hdr(?:10)?|dv|dolby|imax|remux|bluray|blu-ray|bdrip|brrip|webrip|"
    r"web-dl|webdl|web|hdtv|hdrip|dvdrip|amzn|nf|nflx|dsnp|hmax|hulu|itunes|atvp|apple|x264|x265|"
    r"h264|h265|hevc|avc|10bit|8bit|aac|ac3|dts|ddp?5?\.?1|truehd|atmos)\b", re.I)


def _release_tokens(text):
    return {m.lower() for m in _RELEASE_TOKEN_RE.findall(str(text or ""))}


def _release_group(text):
    """"GROUP" from "Show.S01E02.1080p.WEB-DL.x265-GROUP.mkv", lowercased, or None."""
    m = re.search(r"-([A-Za-z0-9]+)(?:\.[a-z0-9]{2,4})?$", str(text or "").strip())
    return m.group(1).lower() if m else None


def release_score(item, filename):
    """How well a subtitle's release names match the playing file: one point per
    shared token, five for the same release group (the strongest timing signal)."""
    if not filename:
        return 0
    want_tokens, want_group = _release_tokens(filename), _release_group(filename)
    names = [item.get("release"), item.get("fileName")] + list(item.get("releases") or [])
    names = [str(n) for n in names if n]
    if not names:
        return 0
    score = len(_release_tokens(" ".join(names)) & want_tokens)
    if want_group and any(_release_group(n) == want_group for n in names):
        score += 5
    return score


def _paid_feature(r):
    return r.status_code == 403 and "paid feature" in str(_json(r).get("message", "")).lower()


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
        if "paid feature" in low:
            return "Dual subtitles, SDH removal and profanity masking need a Pro key"
        if "upgrade required" in low:
            return "AI translation needs a Pro key (store.wyzie.io/#plans)"
        if "free plan" in low:
            return "Those sources need a Pro key. Free keys get OpenSubtitles."
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
        if "translation" in low:
            # /translate: "Too many translations" / "Translation unavailable".
            return "AI translation is busy, try again in a minute (you were not charged)"
        return "Wyzie is briefly unavailable, try again in a moment"
    if status == 404 and "subtitle" in low:
        # /translate found nothing to translate from.
        return "No subtitle to translate for this title"
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

    # Kodi gives language *names* ("English", "Portuguese (Brazil)"), and on
    # Kodi 22 also "original" / "default", which name no language.
    lang_codes = []
    for name in PARAMS.get("languages", "").split(","):
        code = _lang_name_to_iso(name)
        if code and code not in lang_codes:
            lang_codes.append(code)
        elif not code and name.strip().lower() not in _SKIP_LANGS:
            log(f"no language code for {name.strip()!r}, skipped", xbmc.LOGWARNING)

    # source=all gives every key everything its tier allows (free: OpenSubtitles;
    # Pro: every provider). No "hi" parameter: on Wyzie it is a hard filter that
    # drops every non-SDH subtitle, so "prefer" is done here by listing
    # hearing-impaired results first instead.
    params = {"id": target["id"], "key": key, "format": "srt", "source": "all"}
    if target.get("season") is not None and target.get("episode") is not None:
        params["season"] = target["season"]
        params["episode"] = target["episode"]
    # Never an empty language=: with no code at all, every language is asked for.
    if lang_codes:
        params["language"] = ",".join(sorted(lang_codes))

    try:
        r = requests.get(f"{WYZIE_BASE}/search", params=params, timeout=15,
                         headers={"User-Agent": USER_AGENT})
    except requests.RequestException as e:
        # The exception text carries the request URL, API key included.
        log(f"request failed: {type(e).__name__} "
            f"({_redact(WYZIE_BASE + '/search?' + urllib.parse.urlencode(params))})", xbmc.LOGERROR)
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
    # Only links back to Wyzie can be downloaded (see download()), so don't list others.
    data = [item for item in data if isinstance(item, dict) and _wyzie_url(item.get("url"))]

    # AI-translated rows (source "ai") are opt-in: a Pro-only feature that would
    # otherwise flood the list with one machine row per language. When enabled,
    # one row per language: the one for exactly that language (pick_ai_rows).
    ai_rows = pick_ai_rows([item for item in data if _is_ai(item)], lang_codes) \
        if setting("ai_translate") == "true" else []
    keep = {id(item) for item in ai_rows}
    data = [item for item in data if not _is_ai(item) or id(item) in keep]

    prefer_hi = setting("prefer_hi") == "true"
    playing_file = _info("Player.Filename")
    for item in data:
        item["_score"] = release_score(item, playing_file)
    # Stable sort: real subtitles before AI, then (if preferred) hearing-impaired
    # first, then the best match for the playing release; API order otherwise.
    data.sort(key=lambda item: (
        _is_ai(item),
        (not item.get("isHearingImpaired")) if prefer_hi else 0,
        -item["_score"],
    ))

    for entry in build_entries(data, download_options(), dual_language(), lang_codes):
        add_entry(entry)

    xbmcplugin.endOfDirectory(HANDLE)


def download_options():
    """The /c/ options from the settings, e.g. {"sdh": "strip", "plain": "1"}."""
    opts = {}
    if setting("strip_sdh") == "true":
        opts["sdh"] = "strip"
    if setting("mask_profanity") == "true":
        opts["clean"] = "1"
    if setting("clean_format") == "true":
        opts["plain"] = "1"
    return opts


def dual_language():
    """ISO code of the dual-subtitle language setting, or "" when off."""
    return _lang_name_to_iso(setting("dual_lang"))


def build_entries(data, opts, dual, langs=None):
    """List entries for the sorted results: the download options on every real
    subtitle, plus (dual set) a "+ Language" copy of the best DUAL_MAX real
    subtitles in the searched languages (English when none), other than the
    dual language itself, listed first. The single-language rows stay."""
    entries, dual_entries = [], []
    dual_name = _LANG_NAMES.get(dual, dual.upper())
    dual_families = {lang_family(code) for code in langs} if langs else {"en"}
    dual_families.discard(lang_family(dual))
    for item in data:
        is_ai = _is_ai(item)
        optionable = _takes_options(item)
        url = _with_params(item["url"], opts) if optionable and opts else item["url"]
        entry = {
            "label": item.get("display") or item.get("language", "Unknown"),
            "label2": "%s - %s%s" % (item.get("source", "wyzie"),
                                     item.get("release") or item.get("fileName") or "",
                                     " [AI]" if is_ai else ""),
            "flag": item.get("flagUrl", ""),
            "hi": bool(item.get("isHearingImpaired")) and "sdh" not in opts,
            # Same release group as the playing file: Kodi shows its "synced"
            # mark, the convention for "made for this exact release".
            "sync": item.get("_score", 0) >= 5,
            "url": url,
            "format": _sub_format(item.get("format")),
        }
        entries.append(entry)
        if (dual and optionable and lang_family(item.get("language")) in dual_families
                and len(dual_entries) < DUAL_MAX):
            dual_entries.append(dict(entry, url=_with_params(url, {"dual": dual}),
                                     label2="[+ %s] %s" % (dual_name, entry["label2"]),
                                     format="srt" if entry["format"] == "sub" else entry["format"]))
    return dual_entries + entries


def add_entry(entry):
    list_item = xbmcgui.ListItem(label=entry["label"], label2=entry["label2"])
    list_item.setArt({"icon": "0", "thumb": entry["flag"]})
    list_item.setProperty("sync", "true" if entry.get("sync") else "false")
    list_item.setProperty("hearing_imp", "true" if entry["hi"] else "false")
    url = "plugin://%s/?%s" % (ADDON_ID, urllib.parse.urlencode(
        {"action": "download", "url": entry["url"], "format": entry["format"]},
        quote_via=urllib.parse.quote))
    xbmcplugin.addDirectoryItem(handle=HANDLE, url=url, listitem=list_item, isFolder=False)


_DOWNLOAD_NAME_RE = re.compile(r"^wyzie(?:-\d+)?\.(?:%s)$" % "|".join(SUB_FORMATS))


def _clear_old_downloads():
    """Delete subtitles saved by earlier downloads (only our own wyzie*.ext files)."""
    try:
        names = os.listdir(PROFILE)
    except OSError:
        return
    for name in names:
        if _DOWNLOAD_NAME_RE.match(name):
            try:
                os.remove(os.path.join(PROFILE, name))
            except OSError:
                pass


def _download():
    url = PARAMS.get("url")
    fmt = _sub_format(PARAMS.get("format"))
    if not url:
        return
    if not _wyzie_url(url):
        # Any add-on or skin can build a plugin:// link, so only fetch links
        # that point back at Wyzie.
        log(f"refusing to download from {_redact(url)[:200]}", xbmc.LOGWARNING)
        notify("Download failed")
        return
    if not xbmcvfs.exists(PROFILE):
        xbmcvfs.mkdirs(PROFILE)
    _clear_old_downloads()

    # A fresh name per download: reusing one path let a stale file from the
    # previous title be picked up when a later download failed or was cached.
    dest = os.path.join(PROFILE, "wyzie-%d.%s" % (int(time.time() * 1000), fmt))
    try:
        # Each download link costs one request from the key, and is refused
        # with the same statuses as /search when the key can't pay.
        # A dual download can take up to ~20 s the first time (it finds and
        # aligns the second language); everything else answers in about a second.
        r = requests.get(url, timeout=(10, 45) if "dual=" in url else (10, 30),
                         headers={"User-Agent": USER_AGENT})
        if _paid_feature(r):
            # Pro options on a free key: refused without charge. Fetch the plain
            # subtitle instead, and say why the options were skipped.
            notify(refusal_message(r), 6000)
            r = requests.get(_without_pro_options(url), timeout=30, headers={"User-Agent": USER_AGENT})
    except requests.RequestException as e:
        log(f"download failed: {type(e).__name__} ({_redact(url)})", xbmc.LOGERROR)
        notify("Download failed")
        return
    if not r.ok:
        # Says what went wrong, e.g. a busy AI translation (503 "Too many
        # translations" / "Translation unavailable", not charged).
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


def download():
    # The directory is always ended, also after a failure, so Kodi gets an
    # empty answer (with the notification saying why) instead of an error.
    try:
        _download()
    finally:
        xbmcplugin.endOfDirectory(HANDLE)


# ISO 639-1 code -> English name: the languages the Stremio configure page
# offers. The fallback for when xbmc.convertLanguage can't name a language, and
# the dual-subtitle labels.
_LANG_NAMES = dict(pair.split(":") for pair in (
    "en:English|es:Spanish|fr:French|de:German|it:Italian|pt:Portuguese|ru:Russian|"
    "ja:Japanese|ko:Korean|zh:Chinese|ar:Arabic|hi:Hindi|nl:Dutch|pl:Polish|tr:Turkish|"
    "sv:Swedish|da:Danish|fi:Finnish|no:Norwegian|cs:Czech|el:Greek|he:Hebrew|th:Thai|"
    "id:Indonesian|vi:Vietnamese|ro:Romanian|hu:Hungarian|uk:Ukrainian|bg:Bulgarian|"
    "hr:Croatian|sr:Serbian|sk:Slovak|sl:Slovenian|ms:Malay|fa:Persian|ca:Catalan|"
    "et:Estonian|lv:Latvian|lt:Lithuanian|af:Afrikaans|sq:Albanian|am:Amharic|hy:Armenian|"
    "az:Azerbaijani|eu:Basque|be:Belarusian|bn:Bengali|bs:Bosnian|my:Burmese|km:Khmer|"
    "ka:Georgian|gl:Galician|gu:Gujarati|ha:Hausa|is:Icelandic|ig:Igbo|ga:Irish|jv:Javanese|"
    "kn:Kannada|kk:Kazakh|ky:Kyrgyz|lo:Lao|lb:Luxembourgish|mk:Macedonian|mg:Malagasy|"
    "ml:Malayalam|mt:Maltese|mi:Maori|mr:Marathi|mn:Mongolian|ne:Nepali|ps:Pashto|pa:Punjabi|"
    "qu:Quechua|sm:Samoan|gd:Scottish Gaelic|sn:Shona|sd:Sindhi|si:Sinhala|so:Somali|"
    "st:Sesotho|su:Sundanese|sw:Swahili|tg:Tajik|ta:Tamil|tt:Tatar|te:Telugu|ti:Tigrinya|"
    "to:Tongan|tk:Turkmen|ur:Urdu|ug:Uyghur|uz:Uzbek|cy:Welsh|fy:Frisian|xh:Xhosa|yi:Yiddish|"
    "yo:Yoruba|zu:Zulu|ny:Chichewa|co:Corsican|fo:Faroese|fj:Fijian|ht:Haitian Creole|"
    "ku:Kurdish|oc:Occitan|or:Odia|rw:Kinyarwanda|sa:Sanskrit|br:Breton|bo:Tibetan|dv:Divehi|"
    "gn:Guarani|kl:Greenlandic|ln:Lingala|om:Oromo|rm:Romansh|ss:Swati|ts:Tsonga|tn:Tswana|"
    "ve:Venda|wo:Wolof|ak:Akan|lg:Ganda|ki:Kikuyu|ay:Aymara|dz:Dzongkha|ee:Ewe|ff:Fula|"
    "la:Latin|eo:Esperanto|tl:Tagalog|nb:Norwegian Bokmal|nn:Norwegian Nynorsk"
).split("|"))
_LANG_MAP = {name.lower(): code for code, name in _LANG_NAMES.items()}
# Other names Kodi (or its users) use. The regional ones map to OpenSubtitles'
# own codes: pb Portuguese (Brazil), zt Chinese (Traditional), ea Spanish
# (Latin America), which /search takes as they are.
_LANG_MAP.update({
    "portuguese (brazil)": "pb", "portuguese-brazil": "pb", "portuguese (brazilian)": "pb",
    "brazilian portuguese": "pb", "brazilian": "pb",
    "chinese (traditional)": "zt", "chinese (simplified)": "zh", "chinese (simple)": "zh",
    "spanish (latin america)": "ea", "spanish (spain)": "es",
    "farsi": "fa", "sinhalese": "si", "slovene": "sl", "filipino": "tl", "gaelic": "gd",
    "flemish": "nl", "moldavian": "ro", "norwegian bokmål": "nb",
})
# ISO 639-2 (B and T) -> ISO 639-1, for a language given as a three-letter code.
_ISO639_2 = dict(pair.split(":") for pair in (
    "eng:en spa:es fre:fr fra:fr ger:de deu:de ita:it por:pt rus:ru jpn:ja kor:ko chi:zh "
    "zho:zh ara:ar hin:hi dut:nl nld:nl pol:pl tur:tr swe:sv dan:da fin:fi nor:no nob:nb "
    "nno:nn cze:cs ces:cs gre:el ell:el heb:he tha:th ind:id vie:vi rum:ro ron:ro hun:hu "
    "ukr:uk bul:bg hrv:hr srp:sr slo:sk slk:sk slv:sl may:ms msa:ms per:fa fas:fa cat:ca "
    "est:et lav:lv lit:lt afr:af alb:sq sqi:sq amh:am arm:hy hye:hy aze:az baq:eu eus:eu "
    "bel:be ben:bn bos:bs bur:my mya:my khm:km geo:ka kat:ka glg:gl guj:gu hau:ha ice:is "
    "isl:is ibo:ig gle:ga jav:jv kan:kn kaz:kk kir:ky lao:lo ltz:lb mac:mk mkd:mk mlg:mg "
    "mal:ml mlt:mt mao:mi mri:mi mar:mr mon:mn nep:ne pus:ps pan:pa que:qu smo:sm gla:gd "
    "sna:sn snd:sd sin:si som:so sot:st sun:su swa:sw tgk:tg tam:ta tat:tt tel:te tir:ti "
    "ton:to tuk:tk urd:ur uig:ug uzb:uz wel:cy cym:cy fry:fy xho:xh yid:yi yor:yo zul:zu "
    "tgl:tl fil:tl lat:la epo:eo pob:pb zht:zt zhe:zh spl:ea"
).split())
# Kodi 22 also lists these, which are not languages.
_SKIP_LANGS = ("", "original", "default", "none", "off", "forced_only")


def _code_to_iso(code):
    """A language given as a code ("en", "eng", "pt-BR", "zh_TW") as the
    two-letter code /search takes, or ""."""
    c = code.strip().lower().replace("_", "-")
    if re.fullmatch(r"[a-z]{2}", c):
        return c
    if re.fullmatch(r"[a-z]{3}", c):
        return _ISO639_2.get(c, "")
    m = re.fullmatch(r"([a-z]{2})((?:-[a-z0-9]{2,8})+)", c)
    if not m:
        return ""
    tags = m.group(2)[1:].split("-")
    if m.group(1) == "pt" and "br" in tags:
        return "pb"
    if m.group(1) == "zh" and {"hant", "tw", "hk", "mo"} & set(tags):
        return "zt"
    return m.group(1)


def _lang_name_to_iso(name):
    """A Kodi language name as the code /search takes ("" when there is none).

    Kodi hands over English names ("English", "Portuguese (Brazil)"); Kodi 22
    also "original" and "default", which are skipped. Brazilian Portuguese is
    OpenSubtitles' pb (Kodi's ISO 639-1 answer for it would be plain pt).
    """
    raw = str(name or "").strip()
    low = raw.lower()
    if low in _SKIP_LANGS:
        return ""
    if low in _LANG_MAP:
        return _LANG_MAP[low]
    code = _code_to_iso(low) if len(low) <= 12 and re.fullmatch(r"[a-z0-9_-]+", low) else ""
    if code:
        return code
    try:
        code = xbmc.convertLanguage(raw, xbmc.ISO_639_1)
    except Exception:  # older Kodi without it, or a name it doesn't know
        code = ""
    code = str(code or "").strip().lower()
    return code if re.fullmatch(r"[a-z]{2}", code) else ""


# OpenSubtitles' regional codes and the language each belongs to.
_OS_REGIONAL_BASE = {"pb": "pt", "zt": "zh", "ze": "zh", "zc": "zh", "ea": "es", "sp": "es", "iw": "he"}
# The AI rows (by language code) that stand for a searched code, best first.
_AI_TARGETS = {
    "pb": ["pt-br"], "zt": ["zh-tw", "zh-hant", "zh-hk"], "ea": ["es-419", "es-mx"],
    "sp": ["es-es", "es"], "ze": ["zh-hans", "zh-cn", "zh"], "zc": ["zh-hk", "zh-hant"],
}


def lang_family(code):
    """The language a code belongs to: "pt" for pt, pb and pt-BR."""
    base = str(code or "").strip().lower().replace("_", "-").split("-")[0]
    return _OS_REGIONAL_BASE.get(base, base)


def pick_ai_rows(rows, langs):
    """The AI rows to list: one per searched language, the row whose code IS
    that language (en -> "en", pb -> "pt-BR"), a regional variant only when there
    is none. The API lists variants before the plain language (en-AU ... en-US,
    then en), so keeping the first row per language gave "English (Australia)".
    With no languages searched, one row per language in the list."""
    by_code = {}
    for row in rows:
        by_code.setdefault(str(row.get("language") or "").strip().lower(), row)
    if not langs:
        langs = list(dict.fromkeys(lang_family(row.get("language")) for row in rows))
    picked, used = [], set()
    for code in langs:
        c = str(code or "").strip().lower()
        targets = _AI_TARGETS.get(c) or [c]
        row = next((by_code[t] for t in targets if t in by_code and id(by_code[t]) not in used), None)
        if row is None:
            family = lang_family(c)
            row = next((r for r in rows if lang_family(r.get("language")) == family and id(r) not in used), None)
        if row is not None:
            picked.append(row)
            used.add(id(row))
    return picked


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
