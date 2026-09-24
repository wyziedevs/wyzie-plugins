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
from typing import List, Optional, Set
from urllib.parse import urlencode

from babelfish import Language
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

WYZIE_BASE = os.environ.get("WYZIE_BASE", "https://sub.wyzie.io")

# Codenames accepted by the `sources` option (comma-separated), and the tier
# each one needs. The default, `all`, gives every key everything its tier
# allows, so it never fails on tier. Naming only Pro sources with a free key is
# refused (403 "Provider not available on free plan"), and a name that isn't
# live is refused with 400 "Invalid source". Live list: https://sub.wyzie.io/sources
SOURCE_CODENAMES = {
    "charlie": "OpenSubtitles (free)",
    "lima": "IndexSubtitle (free)",
    "foxtrot": "Jimaku, anime (Pro)",
    "india": "YIFY (Pro)",
    "juliet": "Ajatt-Tools, anime (Pro)",
    "mike": "anime (Pro)",
    "november": "anime (Pro)",
}


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
        # A held key is recognised by the body, never by the bare 403.
        if body.get("reinstate") or "key on hold" in low:
            raise WyzieKeyOnHold(
                "Wyzie key on hold: verify your site at %s (or contact %s)"
                % (body.get("reinstate") or "https://store.wyzie.io/verify",
                   body.get("support") or "https://store.wyzie.io/contact"))
        if "free plan" in low:
            raise ConfigurationError(
                "Wyzie sources %r need a Pro key; a free key gets charlie (OpenSubtitles) "
                "and lima (IndexSubtitle). Set sources to 'all' or upgrade: %s"
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
                 search_imdb_id=None, search_tmdb_id=None, season=None, episode=None):
        super().__init__(language, hearing_impaired=hearing_impaired,
                         page_link=page_link)
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
        return self.download_url

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
            if self.season is not None and video.season == self.season:
                matches.add("season")
            if self.episode is not None and video.episode == self.episode:
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


def _same_imdb(a, b) -> bool:
    def norm(value):
        value = str(value).strip().lower()
        return value if value.startswith("tt") else "tt" + value
    return norm(a) == norm(b)


class WyzieProvider(Provider):
    """Wyzie Subs: OpenSubtitles, IndexSubtitle and, on Pro keys, five more providers."""

    languages = {Language.fromalpha2(l) for l in [
        "en", "es", "fr", "de", "it", "pt", "ru", "ja", "ko", "zh",
        "ar", "tr", "pl", "nl", "sv", "da", "fi", "no", "cs", "el",
        "he", "hu", "id", "th", "vi", "uk", "ro", "bg",
    ]}
    video_types = (Movie, Episode)
    subtitle_class = WyzieSubtitle

    def __init__(self, api_key: Optional[str] = None,
                 prefer_hi: bool = False,
                 sources: Optional[str] = None):
        if not api_key:
            raise ConfigurationError(
                "Wyzie API key required. Get one free at "
                "https://store.wyzie.io/redeem"
            )
        self.api_key = api_key
        self.prefer_hi = bool(prefer_hi)
        self.sources = ",".join(s.strip().lower() for s in (sources or "all").split(",") if s.strip()) or "all"
        self.session: Optional[Session] = None

    def initialize(self):
        self.session = Session()
        self.session.headers.update({"User-Agent": "wyzie-bazarr/1.1"})

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

        langs = ",".join(sorted({l.alpha2 for l in languages if getattr(l, "alpha2", None)}))
        if langs:
            params["language"] = langs
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

        out: List[WyzieSubtitle] = []
        for item in data:
            try:
                if not isinstance(item, dict) or not item.get("url"):
                    continue
                lang = SZLanguage.fromalpha2(item.get("language") or "en")
                out.append(WyzieSubtitle(
                    language=lang,
                    hearing_impaired=bool(item.get("isHearingImpaired")),
                    page_link=item.get("url"),
                    download_url=item.get("url"),
                    file_name=item.get("fileName"),
                    releases=_releases(item),
                    source=item.get("source", "wyzie"),
                    format_=item.get("format", "srt"),
                    ai=bool(item.get("ai")),
                    search_imdb_id=imdb,
                    search_tmdb_id=None if imdb else tmdb,
                    season=season,
                    episode=episode,
                ))
            except Exception as e:
                logger.debug("skipping malformed wyzie entry: %s", e)
        if self.prefer_hi:
            # Stable sort: hearing-impaired first, API order otherwise kept.
            out.sort(key=lambda s: not s.hearing_impaired)
        return out

    def download_subtitle(self, subtitle: WyzieSubtitle):
        # Each download link costs one request from the key, and is refused
        # with the same statuses as /search when the key can't pay.
        r = self.session.get(subtitle.download_url, timeout=30)
        if not r.ok:
            _raise_for_account(r, self.sources)
            # Anything else is about this one link (expired token, provider
            # gone): leave content empty so Bazarr just tries the next subtitle
            # instead of throttling the whole provider.
            logger.error("Wyzie download failed (%s): %s", r.status_code,
                         _message(r) or r.text[:200])
            return
        subtitle.content = r.content
