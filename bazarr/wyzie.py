"""
Wyzie Subs provider for Bazarr.

Drop this file into Bazarr's `bazarr/subliminal_patch/providers/` directory and
register the provider in `bazarr/subliminal_patch/extensions.py` (see README).

Covers Plex, Jellyfin, Emby, Sonarr and Radarr by virtue of being a Bazarr
provider, no per-server plugin needed.

Sign up for a free key at https://store.wyzie.io/redeem.
"""
from __future__ import annotations

import logging
import os
from typing import List, Optional, Set

from babelfish import Language
from requests import Session
from subliminal import Episode, Movie
from subliminal.exceptions import AuthenticationError, ConfigurationError
from subliminal_patch.providers import Provider
from subliminal_patch.subtitle import Subtitle
from subzero.language import Language as SZLanguage

logger = logging.getLogger(__name__)

WYZIE_BASE = os.environ.get("WYZIE_BASE", "https://sub.wyzie.io")


class WyzieSubtitle(Subtitle):
    provider_name = "wyzie"
    hash_verifiable = False

    def __init__(self, language, hearing_impaired, page_link, download_url,
                 file_name, release_info, source, format_, ai):
        super().__init__(language, hearing_impaired=hearing_impaired,
                         page_link=page_link)
        self.download_url = download_url
        self.filename = file_name
        self.release_info = release_info
        self.source = source
        self.format = format_
        self.ai = ai
        self.content = None

    @property
    def id(self) -> str:
        return self.download_url

    def get_matches(self, video) -> Set[str]:
        matches = set()
        if isinstance(video, Movie):
            matches.add("title")
        elif isinstance(video, Episode):
            matches.update({"series", "season", "episode"})
        if self.release_info and video.release_group and \
                video.release_group.lower() in self.release_info.lower():
            matches.add("release_group")
        return matches


class WyzieProvider(Provider):
    """Wyzie Subs: aggregates OpenSubtitles, SubDL, Podnapisi and more."""

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
        self.sources = sources or "all"
        self.session: Optional[Session] = None

    def initialize(self):
        self.session = Session()
        self.session.headers.update({"User-Agent": "wyzie-bazarr/1.0"})

    def terminate(self):
        if self.session:
            self.session.close()

    def _imdb(self, video) -> Optional[str]:
        imdb = getattr(video, "imdb_id", None) or getattr(video, "series_imdb_id", None)
        if not imdb:
            return None
        return imdb if imdb.startswith("tt") else f"tt{imdb}"

    def list_subtitles(self, video, languages) -> List[WyzieSubtitle]:
        imdb = self._imdb(video)
        if not imdb:
            return []

        params = {
            "id": imdb,
            "key": self.api_key,
            "source": self.sources,
        }
        if isinstance(video, Episode):
            params["season"] = video.season
            params["episode"] = video.episode

        langs = ",".join(sorted({l.alpha2 for l in languages if l.alpha2}))
        if langs:
            params["language"] = langs
        if self.prefer_hi:
            params["hi"] = "true"

        try:
            r = self.session.get(f"{WYZIE_BASE}/search", params=params, timeout=15)
        except Exception as e:
            logger.error("Wyzie request failed: %s", e)
            return []

        if r.status_code == 401:
            raise AuthenticationError("Invalid Wyzie API key")
        if r.status_code == 402:
            logger.warning("Wyzie: paid balance depleted. "
                           "Top up at https://store.wyzie.io/topup")
            return []
        if r.status_code == 429:
            logger.warning("Wyzie: daily free limit hit. "
                           "Upgrade at https://store.wyzie.io/#plans")
            return []
        if not r.ok:
            logger.error("Wyzie %s: %s", r.status_code, r.text[:200])
            return []

        data = r.json()
        if isinstance(data, dict):
            data = data.get("subtitles", [])

        out: List[WyzieSubtitle] = []
        for item in data:
            try:
                lang_code = item.get("language", "en")
                lang = SZLanguage.fromalpha2(lang_code)
                out.append(WyzieSubtitle(
                    language=lang,
                    hearing_impaired=item.get("isHearingImpaired", False),
                    page_link=item.get("url"),
                    download_url=item.get("url"),
                    file_name=item.get("fileName"),
                    release_info=item.get("release") or item.get("matchedRelease"),
                    source=item.get("source", "wyzie"),
                    format_=item.get("format", "srt"),
                    ai=bool(item.get("ai")),
                ))
            except Exception as e:
                logger.debug("skipping malformed wyzie entry: %s", e)
        return out

    def download_subtitle(self, subtitle: WyzieSubtitle):
        r = self.session.get(subtitle.download_url, timeout=30)
        r.raise_for_status()
        subtitle.content = r.content
