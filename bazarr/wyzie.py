"""
Wyzie Subs provider for Bazarr.

Drop this file into Bazarr's `bazarr/subliminal_patch/providers/` directory and
register the provider in `bazarr/subliminal_patch/extensions.py` (see README).

Covers Plex, Jellyfin, Emby, Sonarr and Radarr by virtue of being a Bazarr
provider, no per-server plugin needed.

Sign up for a free key at https://store.wyzie.io/redeem.
"""
from __future__ import annotations

import datetime
import logging
import os
import re
from typing import Dict, List, Optional, Set
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from guessit import guessit
from requests import Session
from subliminal import Episode, Movie
from subliminal.exceptions import (AuthenticationError, ConfigurationError,
                                   DownloadLimitExceeded, ProviderError,
                                   ServiceUnavailable)
from subliminal_patch.providers import Provider
from subliminal_patch.subtitle import Subtitle, guess_matches
from subzero.language import Language as SZLanguage

logger = logging.getLogger(__name__)

VERSION = "1.3.1"
WYZIE_BASE = os.environ.get("WYZIE_BASE", "https://sub.wyzie.io")

# The ISO 639-1 languages Wyzie serves (its sources plus AI translation). The
# provider offers each one babelfish knows, plus the regional ones Bazarr has
# as their own languages (see _REGIONAL).
API_LANGUAGES = (
    "ab af ak am ar as ay az be bg bi bn br bs ca ch co cr cs cy da de dv ee el en eo es et "
    "eu fa ff fi fj fo fr fy ga gd gl gn gu ha he hi hr ht hu hy hz ia id ie ig ik is it ja "
    "jv ka ki kj kk kl km kn ko ku ky lb lg ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na "
    "nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rn ro ru rw sa sc sd sg "
    "si sk sl sm sn so sq sr ss st su sv sw ta te tg th tk tl tn tr ts tt tw ty ug uk ur uz "
    "ve vi vo wa wo xh yi yo za zh zu"
).split()

# Bazarr's regional languages and OpenSubtitles' two-letter codes for them,
# which /search takes and returns: pb Portuguese (Brazil), zt Chinese
# (Traditional), ea Spanish (Latin America; Bazarr's "Spanish (Latino)" is es-MX).
_REGIONAL = {"pb": ("por", "BR"), "zt": ("zho", "TW"), "ea": ("spa", "MX")}
# Other row codes babelfish has no alpha2 for: sp Spanish (Spain), ze / zc
# Chinese (simplified / Cantonese), iw the old code for Hebrew.
_ROW_ALIASES = {"sp": ("spa",), "ze": ("zho",), "zc": ("zho",), "iw": ("heb",)}


def _wanted_code(language) -> Optional[str]:
    """The /search code for a Bazarr language: pb / zt / ea for the regional
    ones, else ISO 639-1. None when there is no two-letter code."""
    alpha3 = str(getattr(language, "alpha3", "") or "")
    country = str(getattr(language, "country", None) or "").upper()
    script = str(getattr(language, "script", None) or "")
    if alpha3 == "por" and country == "BR":
        return "pb"
    if alpha3 == "zho" and (country in ("TW", "HK", "MO") or script == "Hant"):
        return "zt"
    if alpha3 == "spa" and country and country != "ES":
        return "ea"
    try:
        code = language.alpha2
    except Exception:  # babelfish has no alpha2 for it
        return None
    return str(code).lower() if code else None


def _row_language(code) -> SZLanguage:
    """The Bazarr language of a result's `language`, which is ISO 639-1, one of
    OpenSubtitles' own codes (pb, zt, ea, sp, ze, zc) or, on AI rows, a regional
    tag (pt-BR, zh-Hant, es-419). Raises for a code babelfish can't place."""
    low = str(code or "").strip().lower().replace("_", "-")
    if low in _REGIONAL:
        return SZLanguage(*_REGIONAL[low])
    if low in _ROW_ALIASES:
        return SZLanguage(*_ROW_ALIASES[low])
    base, _, rest = low.partition("-")
    tags = rest.split("-") if rest else []
    if base == "pt" and "br" in tags:
        return SZLanguage(*_REGIONAL["pb"])
    if base == "zh" and {"hant", "tw", "hk", "mo"} & set(tags):
        return SZLanguage(*_REGIONAL["zt"])
    if base == "es" and tags and tags[0] != "es":
        return SZLanguage(*_REGIONAL["ea"])
    return SZLanguage.fromalpha2(base)


# OpenSubtitles' regional codes and the language each belongs to.
_OS_REGIONAL_BASE = {"pb": "pt", "zt": "zh", "ze": "zh", "zc": "zh", "ea": "es", "sp": "es", "iw": "he"}
# The AI rows (by language code) that stand for a wanted code, best first.
_AI_TARGETS = {
    "pb": ["pt-br"], "zt": ["zh-tw", "zh-hant", "zh-hk"], "ea": ["es-419", "es-mx"],
    "sp": ["es-es", "es"], "ze": ["zh-hans", "zh-cn", "zh"], "zc": ["zh-hk", "zh-hant"],
}


def _lang_family(code) -> str:
    """The language a code belongs to: "pt" for pt, pb and pt-BR."""
    base = str(code or "").strip().lower().replace("_", "-").split("-")[0]
    return _OS_REGIONAL_BASE.get(base, base)


def _pick_ai_rows(rows: List[dict], codes: List[str]) -> Dict[int, str]:
    """Which AI row to offer for each wanted code: the row whose code IS that
    language (en -> "en", pb -> "pt-BR"), a regional variant only when there is
    none. The API lists variants before the plain language (en-AU ... en-US,
    then en), so keeping the first row per language gave "English (Australia)".
    Returns {id(row): wanted code}."""
    by_code: Dict[str, dict] = {}
    for row in rows:
        by_code.setdefault(str(row.get("language") or "").strip().lower(), row)
    picked: Dict[int, str] = {}
    for code in codes:
        targets = _AI_TARGETS.get(code) or [code]
        row = next((by_code[t] for t in targets if t in by_code and id(by_code[t]) not in picked), None)
        if row is None:
            family = _lang_family(code)
            row = next((r for r in rows if _lang_family(r.get("language")) == family
                        and id(r) not in picked), None)
        if row is not None:
            picked[id(row)] = code
    return picked


# Season / episode numbers a release name states: S01E02 (S01E02E03), 1x02,
# "Season 2", "E05" / "Episode 5", and anime's "Show - 05".
_SXE_RE = re.compile(r"(?i)\bS(\d{1,2})[ ._-]?((?:E\d{1,4}[ ._-]?)+)")
_NXN_RE = re.compile(r"(?i)\b(\d{1,2})x(\d{1,4})\b")
_SEASON_RE = re.compile(r"(?i)\bseason[ ._-]?(\d{1,2})\b")
_EPISODE_RE = re.compile(r"(?i)(?:\b(?:ep|episode)[ ._-]?|\bE)(\d{1,4})\b")
_ANIME_EP_RE = re.compile(r"\s-\s(\d{1,4})(?:v\d)?(?=[\s.\[(]|$)")


def _stated_episode(name: str):
    """(seasons, episodes) a release name states, as sets (empty when it
    names none). A 4-digit number that reads as a year is not an episode."""
    seasons, episodes = set(), set()
    for m in _SXE_RE.finditer(name):
        seasons.add(int(m.group(1)))
        episodes.update(int(e) for e in re.findall(r"\d+", m.group(2)))
    for m in _NXN_RE.finditer(name):
        seasons.add(int(m.group(1)))
        episodes.add(int(m.group(2)))
    if not seasons:
        seasons.update(int(s) for s in _SEASON_RE.findall(name))
    if not episodes:
        for pattern in (_EPISODE_RE, _ANIME_EP_RE):
            episodes.update(int(e) for e in pattern.findall(name)
                            if not re.fullmatch(r"(?:19|20)\d\d", e))
    return seasons, episodes

# Codenames accepted by the `sources` option (comma-separated), and the tier
# each one needs. The default, `all`, gives every key everything its tier
# allows, so it never fails on tier. Naming only Pro sources with a free key is
# refused (403 "Provider not available on free plan"), and a name that isn't
# live is refused with 400 "Invalid source". Live list: https://sub.wyzie.io/sources
SOURCE_CODENAMES = {
    "charlie": "OpenSubtitles (free)",
    "foxtrot": "Jimaku, anime (Pro)",
    "india": "YIFY (Pro)",
    "juliet": "Ajatt-Tools, anime (Pro)",
    "mike": "anime (Pro)",
}


# Download options Wyzie applies to a /c/ link (see the README). The Pro ones
# are refused on a free key (403 "Paid feature", not charged); the download is
# then retried without them.
PRO_OPTIONS = ("dual", "sdh", "clean")
TEXT_FORMATS = ("srt", "vtt", "webvtt", "ass", "ssa", "sub", "ttml", "dfxp", "txt")


def _with_params(url: str, params: Dict[str, str]) -> str:
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in params]
    query += [(k, str(v)) for k, v in params.items() if v not in (None, "")]
    return urlunsplit(parts._replace(query=urlencode(query)))


def _without_pro_options(url: str) -> str:
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if k.lower() not in PRO_OPTIONS]
    return urlunsplit(parts._replace(query=urlencode(query)))


def _without_token(url: str) -> str:
    """The link without its per-search tok= / tk= token (and any key)."""
    parts = urlsplit(str(url or ""))
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if k.lower() not in ("tok", "tk", "key")]
    return urlunsplit(parts._replace(query=urlencode(query)))


def _flag(value) -> bool:
    """A Bazarr setting as a bool (it may arrive as a bool or a string)."""
    return value is True or str(value).strip().lower() in ("1", "true", "yes", "on")


class WyzieKeyOnHold(ProviderError):
    """403 "Key on hold": a valid key paused by Wyzie's scraper defence.

    Deliberately NOT an AuthenticationError: the key is right and nothing in
    Bazarr's settings is wrong, the owner just has to verify their site at
    https://store.wyzie.io/verify (or contact support). Bazarr throttles on the
    exception class and has no entry for this one, so it backs off for its
    default 10 minutes, shows "WyzieKeyOnHold" as the reason, and resumes on
    its own once the key is reinstated.
    """


def _body(r) -> dict:
    try:
        body = r.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _message(r) -> str:
    return str(_body(r).get("message") or "")


def _redact(url: str) -> str:
    """A URL fit for the log: the API key and download token masked."""
    return re.sub(r"(?i)([?&](?:key|api_key|tok)=)[^&#]*", r"\1***", str(url or ""))


def _no_results(r) -> bool:
    """True when a 400 response is Wyzie's "No subtitles found" answer."""
    return "no subtitles found" in (_message(r) or r.text or "").lower()


def _reset_text(reset_at) -> str:
    try:
        when = datetime.datetime.fromtimestamp(int(reset_at), tz=datetime.timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return "midnight UTC"
    return when.strftime("%Y-%m-%d %H:%M UTC")


def _raise_for_account(r, sources: str) -> None:
    """Raise the subliminal exception for a refusal about the key or account.

    /search and the /c/ download links answer with the same statuses and body
    fields. Bazarr throttles a provider by exception class (see
    bazarr/app/get_providers.py provider_throttle_map), so the class follows
    what the user has to do about it:

      AuthenticationError (12 h)   403 "Invalid API key" / 401: the key is wrong.
      WyzieKeyOnHold (10 min)      403 "Key on hold": verify the site, resumes by itself.
      ConfigurationError (12 h)    403 "Provider not available on free plan":
                                   the `sources` option needs a Pro key.
      DownloadLimitExceeded (3 h)  402 balance used up / 429 daily limit.
      ServiceUnavailable (20 min)  503.

    Returns without raising for anything else, including a download link's
    401 "Download link invalid or expired", which is about that one link.
    """
    status = r.status_code
    body = _body(r)
    message = str(body.get("message") or "")
    low = message.lower()
    if status == 403:
        if "paid feature" in low:
            # dual / strip_sdh / mask_profanity on a free key. download_subtitle
            # retries without them first, so this only fires if that also failed.
            raise ConfigurationError(
                "Wyzie: dual_language, strip_sdh and mask_profanity need a Pro key. "
                "Turn them off or upgrade: https://store.wyzie.io/#plans")
        # A held key is recognised by the body, never by the bare 403.
        if body.get("reinstate") or "key on hold" in low:
            raise WyzieKeyOnHold(
                "Wyzie key on hold: verify your site at %s (or contact %s)"
                % (body.get("reinstate") or "https://store.wyzie.io/verify",
                   body.get("support") or "https://store.wyzie.io/contact"))
        if "free plan" in low:
            raise ConfigurationError(
                "Wyzie sources %r need a Pro key; a free key gets charlie (OpenSubtitles). "
                "Set sources to 'all' or upgrade: %s"
                % (sources, str(body.get("details") or "https://store.wyzie.io/#plans")))
        raise AuthenticationError("Invalid Wyzie API key" if "invalid api key" in low
                                  else "Wyzie refused the key: " + (message or "403"))
    if status == 401:
        if "download link" in low:
            return  # 401 "Download link invalid or expired": about one link, not the key
        raise AuthenticationError("Wyzie: " + (message or "API key required"))
    if status == 402:
        raise DownloadLimitExceeded(
            "Wyzie Pro balance used up. Top up at %s" % (body.get("topup") or "https://store.wyzie.io/topup"))
    if status == 429:
        raise DownloadLimitExceeded(
            "Wyzie daily limit reached, resets at %s. Upgrade at %s"
            % (_reset_text(body.get("reset_at")), body.get("upgrade") or "https://store.wyzie.io/#plans"))
    if status == 503:
        raise ServiceUnavailable("Wyzie: " + (message or "service temporarily unavailable"))


def _is_ai(item) -> bool:
    return bool(item.get("ai")) or item.get("source") == "ai"


def _releases(item) -> List[str]:
    """Every release name the API reported for a subtitle, de-duplicated."""
    names = [item.get("release"), item.get("fileName"), item.get("matchedRelease")]
    names += item.get("releases") or []
    seen, out = set(), []
    for name in names:
        name = str(name or "").strip()
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    return out


class WyzieSubtitle(Subtitle):
    provider_name = "wyzie"
    hash_verifiable = False

    def __init__(self, language, hearing_impaired, page_link, download_url,
                 file_name, releases, source, format_, ai,
                 search_imdb_id=None, search_tmdb_id=None, season=None, episode=None,
                 subtitle_id=None, hi_known=False):
        super().__init__(language, hearing_impaired=hearing_impaired,
                         page_link=page_link)
        # Like other subliminal_patch providers, the language carries the HI
        # flag, so an SDH subtitle is saved as one.
        if hearing_impaired:
            self.language = SZLanguage.rebuild(language, hi=True)
        # The API says whether each subtitle is SDH (isHearingImpaired), so
        # Bazarr can hold a "HI only" / "no HI" profile to it.
        self.hearing_impaired_verifiable = bool(hi_known)
        self.subtitle_id = subtitle_id
        self.download_url = download_url
        self.filename = file_name
        self.releases = list(releases or [])
        # Bazarr's manual search splits release_info on commas.
        self.release_info = ", ".join(self.releases)
        self.source = source
        self.format = format_
        self.ai = ai
        # The ids / episode the provider searched by. Wyzie only returns
        # subtitles for that title (and that season+episode), so they are what
        # the result is known to match.
        self.search_imdb_id = search_imdb_id
        self.search_tmdb_id = search_tmdb_id
        self.season = season
        self.episode = episode
        self.content = None

    @property
    def id(self) -> str:
        # Stable across searches, so Bazarr's blacklist (keyed on provider +
        # id) matches next time. The download URL's tok= changes every search.
        return self.subtitle_id or _without_token(self.download_url)

    def _wrong_episode(self, video):
        """(wrong season, wrong episode): a release name states another season /
        episode than the video's, and none states the video's own. Anime
        sources sometimes return a neighbouring episode's file."""
        seasons, episodes = set(), set()
        for name in self.releases:
            s, e = _stated_episode(name)
            seasons |= s
            episodes |= e
        wrong_season = bool(seasons) and video.season not in seasons
        wanted = set(video.episode if isinstance(video.episode, (list, tuple)) else [video.episode])
        wanted.add(getattr(video, "absolute_episode", None))
        wrong_episode = wrong_season or (bool(episodes) and not (episodes & wanted))
        return wrong_season, wrong_episode

    def get_matches(self, video) -> Set[str]:
        matches = set()
        type_ = "episode" if isinstance(video, Episode) else "movie"
        if isinstance(video, Episode):
            series_imdb = getattr(video, "series_imdb_id", None)
            if self.search_imdb_id and series_imdb and _same_imdb(series_imdb, self.search_imdb_id):
                # Searched by this show's IMDb id: the series (and its year) is
                # established. compute_score adds series + year for this match.
                matches.add("series_imdb_id")
            if self.search_imdb_id or self.search_tmdb_id:
                matches.add("series")
                if video.year:
                    matches.add("year")
            # Searched by this season + episode, so credited, unless the
            # release name says it is another one.
            wrong_season, wrong_episode = self._wrong_episode(video)
            if self.season is not None and video.season == self.season and not wrong_season:
                matches.add("season")
            if self.episode is not None and video.episode == self.episode and not wrong_episode:
                matches.add("episode")
        else:
            imdb = getattr(video, "imdb_id", None)
            if self.search_imdb_id and imdb and _same_imdb(imdb, self.search_imdb_id):
                # compute_score turns a movie imdb_id match into title + year.
                matches.add("imdb_id")
            if self.search_imdb_id or self.search_tmdb_id:
                matches.add("title")
                if video.year:
                    matches.add("year")

        # Credit what the release names prove (source, resolution, codecs,
        # release group, ...), the same way other subliminal_patch providers do.
        for release in self.releases:
            try:
                matches |= guess_matches(video, guessit(release, {"type": type_}))
            except Exception as e:  # a malformed name must not sink the result
                logger.debug("Wyzie: could not guess %r: %s", release, e)
        if "release_group" not in matches and video.release_group:
            group = video.release_group.lower()
            if any(group in release.lower() for release in self.releases):
                matches.add("release_group")

        self.matches = matches
        return matches


def _provider_languages() -> Set[SZLanguage]:
    """Every language Wyzie serves that babelfish knows, plus Portuguese
    (Brazil), Chinese (Traditional) and Spanish (Latino), each with its forced
    and HI variants, like other subliminal_patch providers (opensubtitlescom):
    Bazarr only asks a provider for the profile languages it lists, flags
    included, so without them an HI-only profile skipped Wyzie altogether."""
    languages = {SZLanguage(*parts) for parts in _REGIONAL.values()}
    for code in API_LANGUAGES:
        try:
            languages.add(SZLanguage.fromalpha2(code))
        except Exception:  # not an alpha2 babelfish knows
            pass
    languages.update({SZLanguage.rebuild(lang, forced=True) for lang in languages})
    languages.update({SZLanguage.rebuild(lang, hi=True) for lang in languages})
    return languages


def _same_imdb(a, b) -> bool:
    def norm(value):
        value = str(value).strip().lower()
        return value if value.startswith("tt") else "tt" + value
    return norm(a) == norm(b)


class WyzieProvider(Provider):
    """Wyzie Subs: OpenSubtitles and, on Pro keys, more providers (incl. anime)."""

    languages = _provider_languages()
    video_types = (Movie, Episode)
    subtitle_class = WyzieSubtitle

    def __init__(self, api_key: Optional[str] = None,
                 prefer_hi: bool = False,
                 sources: Optional[str] = None,
                 ai_translate: bool = False,
                 dual_language: Optional[str] = None,
                 strip_sdh: bool = False,
                 mask_profanity: bool = False,
                 clean_format: bool = False):
        if not api_key:
            raise ConfigurationError(
                "Wyzie API key required. Get one free at "
                "https://store.wyzie.io/redeem"
            )
        self.api_key = api_key
        self.prefer_hi = bool(prefer_hi)
        self.sources = ",".join(s.strip().lower() for s in (sources or "all").split(",") if s.strip()) or "all"
        # AI-translated results (source "ai") are a Pro-only feature and are
        # dropped by default: Bazarr scores them low (no release info) and most
        # users want real subtitles. Turn on to let them fill gaps in a language
        # that has no native subtitle. Each AI download costs 25 requests.
        self.ai_translate = _flag(ai_translate)
        # Applied to every real (/c/) download:
        #   dual_language   two-letter code: each subtitle in another language is
        #                   saved with this language merged under its lines (Pro)
        #   strip_sdh       remove hearing-impaired cues (Pro)
        #   mask_profanity  mask strong profanity, English (Pro)
        #   clean_format    strip styling, fix overlapping lines (all keys)
        dual = str(dual_language or "").strip().lower()
        if dual in ("", "off", "none"):
            dual = ""
        elif not re.fullmatch(r"[a-z]{2}", dual):
            raise ConfigurationError(
                "Wyzie dual_language must be a two-letter code such as 'es', got %r" % dual_language)
        self.dual_language = dual
        self.download_options: Dict[str, str] = {}
        if _flag(strip_sdh):
            self.download_options["sdh"] = "strip"
        if _flag(mask_profanity):
            self.download_options["clean"] = "1"
        if _flag(clean_format):
            self.download_options["plain"] = "1"
        self.session: Optional[Session] = None

    def initialize(self):
        self.session = Session()
        self.session.headers.update({"User-Agent": "wyzie-bazarr/" + VERSION})

    def terminate(self):
        if self.session:
            self.session.close()

    @staticmethod
    def _search_ids(video):
        """(imdb_id, tmdb_id) to search by. For an episode it is the SHOW's id
        (Wyzie takes show + season + episode); an episode's own IMDb id would
        name the wrong title. /search takes a bare TMDB id as is."""
        if isinstance(video, Episode):
            imdb = getattr(video, "series_imdb_id", None)
            tmdb = getattr(video, "series_tmdb_id", None)
        else:
            imdb = getattr(video, "imdb_id", None)
            tmdb = getattr(video, "tmdb_id", None)
        imdb = str(imdb).strip() if imdb else None
        if imdb and not imdb.startswith("tt"):
            imdb = "tt" + imdb if imdb.isdigit() else None
        tmdb = str(tmdb).strip() if tmdb else None
        if tmdb and not tmdb.isdigit():
            tmdb = None
        return imdb, tmdb

    def list_subtitles(self, video, languages) -> List[WyzieSubtitle]:
        imdb, tmdb = self._search_ids(video)
        search_id = imdb or tmdb
        if not search_id:
            logger.debug("Wyzie: no IMDb or TMDB id for %r, skipping", video)
            return []

        params = {
            "id": search_id,
            "key": self.api_key,
            "source": self.sources,
        }
        season = episode = None
        if isinstance(video, Episode):
            if video.season is None or video.episode is None:
                return []
            season, episode = video.season, video.episode
            params["season"] = season
            params["episode"] = episode

        # Wyzie doesn't mark forced (foreign-parts-only) subtitles, so a
        # forced-only request has nothing here; full subtitles would be saved
        # as forced ones.
        if languages and all(getattr(l, "forced", False) for l in languages):
            logger.debug("Wyzie: forced subtitles only, skipping")
            return []
        # One code per wanted language (its HI/forced variants are the same
        # language here): pb / zt / ea for the regional ones, else ISO 639-1.
        wanted: Dict[str, object] = {}
        for lang in sorted(languages, key=str):
            code = _wanted_code(lang)
            if code and code not in wanted and not getattr(lang, "forced", False):
                wanted[code] = SZLanguage.rebuild(lang, hi=False, forced=False)
        if wanted:
            params["language"] = ",".join(sorted(wanted))
        # No "hi" parameter: on Wyzie it is a hard filter that drops every
        # non-SDH subtitle. prefer_hi only orders the results (below); Bazarr's
        # own language-profile HI setting decides what gets downloaded.

        try:
            r = self.session.get(f"{WYZIE_BASE}/search", params=params, timeout=15)
        except Exception as e:
            # Only the exception class: its text carries the request URL, API
            # key included.
            logger.error("Wyzie request failed: %s (%s)", type(e).__name__,
                         _redact(f"{WYZIE_BASE}/search?{urlencode(params)}"))
            return []

        if r.status_code == 400:
            if _no_results(r):
                # Wyzie answers 400 "No subtitles found" rather than an empty list.
                return []
            if "invalid source" in _message(r).lower():
                msg = ("Wyzie rejected the 'sources' setting %r (400 Invalid source: %s). "
                       "Use 'all' or a comma list of: %s."
                       % (self.sources, _body(r).get("details") or "unknown codename",
                          ", ".join("%s = %s" % kv for kv in SOURCE_CODENAMES.items())))
                logger.error(msg)
                raise ConfigurationError(msg)
            logger.error("Wyzie 400 for %s: %s", search_id, _message(r) or r.text[:200])
            return []
        if not r.ok:
            _raise_for_account(r, self.sources)
            logger.error("Wyzie %s: %s", r.status_code, r.text[:200])
            return []

        data = r.json()
        if isinstance(data, dict):
            data = data.get("subtitles", [])

        data = [item for item in data if isinstance(item, dict) and item.get("url")]
        # AI rows are opt-in, one per wanted language: the exact one. Each is
        # labelled with that wanted language, so pt-BR fills a pt-BR profile.
        ai_pick = _pick_ai_rows([item for item in data if _is_ai(item)], sorted(wanted)) \
            if self.ai_translate else {}
        title_key = search_id + ("" if episode is None else ":%sx%s" % (season, episode))

        out: List[WyzieSubtitle] = []
        for item in data:
            try:
                ai = _is_ai(item)
                if ai:
                    code = ai_pick.get(id(item))
                    if code is None:
                        continue
                    lang = wanted[code]
                    # The AI row id ("ai-en") is the same on every title.
                    sub_id = "ai:%s:%s" % (title_key, item.get("language"))
                else:
                    lang = _row_language(item.get("language") or "en")
                    sub_id = ("%s:%s" % (item.get("source") or "wyzie", item["id"])
                              if item.get("id") not in (None, "") else None)
                hi_known = isinstance(item.get("isHearingImpaired"), bool)
                out.append(WyzieSubtitle(
                    language=lang,
                    hearing_impaired=bool(item.get("isHearingImpaired")),
                    page_link=item.get("url"),
                    download_url=item.get("url"),
                    file_name=item.get("fileName"),
                    releases=_releases(item),
                    source=item.get("source", "wyzie"),
                    format_=item.get("format", "srt"),
                    ai=ai,
                    search_imdb_id=imdb,
                    search_tmdb_id=None if imdb else tmdb,
                    season=season,
                    episode=episode,
                    subtitle_id=sub_id,
                    # An AI row's SDH-ness is its source's, which isn't known.
                    hi_known=hi_known and not ai,
                ))
            except Exception as e:
                logger.debug("skipping wyzie entry (%s): %s", item.get("language"), e)
        if self.prefer_hi:
            # Stable sort: hearing-impaired first, API order otherwise kept.
            out.sort(key=lambda s: not s.hearing_impaired)
        return out

    def _download_url(self, subtitle: WyzieSubtitle) -> str:
        """The subtitle's link with the configured options. Only /c/ downloads of
        text subtitles take them (AI rows are /translate links; an image
        subtitle with options is a 422)."""
        url = subtitle.download_url
        if subtitle.ai or not urlsplit(url).path.startswith("/c/"):
            return url
        if str(subtitle.format or "srt").lower() not in TEXT_FORMATS:
            return url
        opts = dict(self.download_options)
        family = _lang_family(_wanted_code(subtitle.language))
        if self.dual_language and family and family != _lang_family(self.dual_language):
            opts["dual"] = self.dual_language
        return _with_params(url, opts) if opts else url

    def download_subtitle(self, subtitle: WyzieSubtitle):
        # Each download link costs one request from the key, and is refused
        # with the same statuses as /search when the key can't pay. A dual
        # download that finds its second language costs one more.
        url = self._download_url(subtitle)
        r = self.session.get(url, timeout=45)
        if r.status_code == 403 and "paid feature" in _message(r).lower():
            # Pro options on a free key: refused without charge. Take the plain
            # subtitle rather than nothing.
            logger.warning("Wyzie: dual_language / strip_sdh / mask_profanity need a Pro key; "
                           "downloading without them")
            r = self.session.get(_without_pro_options(url), timeout=30)
        if r.ok and self.dual_language and r.headers.get("X-Dual") == "unavailable":
            logger.info("Wyzie: no %s subtitle lined up with %s, saved it single-language",
                        self.dual_language, _redact(subtitle.download_url)[:120])
        if not r.ok and subtitle.ai and r.status_code == 503:
            # A busy AI translation (503 "Too many translations" / "Translation
            # unavailable", not charged) is about this one download: skip it
            # rather than raise ServiceUnavailable, which would throttle the
            # whole provider for 20 minutes.
            logger.warning("Wyzie: AI translation busy (%s), skipping it for now",
                           _message(r) or "503")
            return
        if not r.ok:
            _raise_for_account(r, self.sources)
            # Anything else is about this one link (expired token, provider
            # gone): leave content empty so Bazarr just tries the next subtitle
            # instead of throttling the whole provider.
            logger.error("Wyzie download failed (%s): %s", r.status_code,
                         _message(r) or r.text[:200])
            return
        subtitle.content = r.content
