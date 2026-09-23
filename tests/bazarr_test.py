#!/usr/bin/env python3
"""
Test the Bazarr provider WITHOUT installing Bazarr / Plex / Jellyfin.

Bazarr's provider stack (subliminal, subliminal_patch, subzero, babelfish) is
heavy and Bazarr-specific. We don't need it: we stub the small surface the
provider actually touches, then drive the REAL provider logic
(WyzieProvider.list_subtitles / download_subtitle) against the live Wyzie API
with a fake Movie/Episode object.

This catches the things that actually break: request building, response
mapping, language handling, and error paths.

Run from the repo root:
    WYZIE_KEY=wyzie-xxxx python tests/bazarr_test.py
    (PowerShell)  $env:WYZIE_KEY="wyzie-..."; python tests/bazarr_test.py
"""
import os
import sys
import types
import importlib.util

KEY = os.environ.get("WYZIE_KEY")
HERE = os.path.dirname(os.path.abspath(__file__))
PROVIDER_PATH = os.path.join(HERE, "..", "bazarr", "wyzie.py")

# ---------------------------------------------------------------------------
# Stub the Bazarr/subliminal module surface the provider imports.
# ---------------------------------------------------------------------------
class FakeLang:
    """Stand-in for babelfish/subzero Language."""
    def __init__(self, alpha2):
        self.alpha2 = alpha2
    def __hash__(self):
        return hash(self.alpha2)
    def __eq__(self, other):
        return getattr(other, "alpha2", None) == self.alpha2
    @classmethod
    def fromalpha2(cls, code):
        return cls(code)

def install_stubs():
    babelfish = types.ModuleType("babelfish")
    babelfish.Language = FakeLang
    sys.modules["babelfish"] = babelfish

    subliminal = types.ModuleType("subliminal")
    class Movie:  # minimal video objects
        def __init__(self, **kw): self.__dict__.update(kw)
    class Episode:
        def __init__(self, **kw): self.__dict__.update(kw)
    subliminal.Movie = Movie
    subliminal.Episode = Episode
    sys.modules["subliminal"] = subliminal

    sub_exc = types.ModuleType("subliminal.exceptions")
    class ProviderError(Exception): pass
    class AuthenticationError(ProviderError): pass
    class ConfigurationError(ProviderError): pass
    class DownloadLimitExceeded(ProviderError): pass
    class ServiceUnavailable(ProviderError): pass
    sub_exc.ProviderError = ProviderError
    sub_exc.AuthenticationError = AuthenticationError
    sub_exc.ConfigurationError = ConfigurationError
    sub_exc.DownloadLimitExceeded = DownloadLimitExceeded
    sub_exc.ServiceUnavailable = ServiceUnavailable
    sys.modules["subliminal.exceptions"] = sub_exc

    # guessit + guess_matches: a tiny stand-in that reads the resolution and
    # the release group, enough to see release-name matching take effect.
    guessit_mod = types.ModuleType("guessit")
    def guessit(name, options=None):
        import re
        guess = {}
        m = re.search(r"(2160|1080|720|480)p", name)
        if m:
            guess["screen_size"] = m.group(0)
        m = re.search(r"-([A-Za-z0-9]+)$", name)
        if m:
            guess["release_group"] = m.group(1)
        return guess
    guessit_mod.guessit = guessit
    sys.modules["guessit"] = guessit_mod

    sp = types.ModuleType("subliminal_patch")
    sys.modules["subliminal_patch"] = sp
    sp_providers = types.ModuleType("subliminal_patch.providers")
    class Provider:  # base class, no behaviour needed
        pass
    sp_providers.Provider = Provider
    sys.modules["subliminal_patch.providers"] = sp_providers
    sp_subtitle = types.ModuleType("subliminal_patch.subtitle")
    class Subtitle:
        def __init__(self, language, hearing_impaired=False, page_link=None):
            self.language = language
            self.hearing_impaired = hearing_impaired
            self.page_link = page_link
    def guess_matches(video, guess, partial=False):
        matches = set()
        if guess.get("screen_size") and guess["screen_size"] == getattr(video, "resolution", None):
            matches.add("resolution")
        group = getattr(video, "release_group", None)
        if group and guess.get("release_group", "").lower() == group.lower():
            matches.add("release_group")
        return matches
    sp_subtitle.Subtitle = Subtitle
    sp_subtitle.guess_matches = guess_matches
    sys.modules["subliminal_patch.subtitle"] = sp_subtitle

    subzero = types.ModuleType("subzero")
    sys.modules["subzero"] = subzero
    subzero_lang = types.ModuleType("subzero.language")
    subzero_lang.Language = FakeLang
    sys.modules["subzero.language"] = subzero_lang

    return Movie, Episode

def load_provider():
    spec = importlib.util.spec_from_file_location("wyzie_provider", PROVIDER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

# ---------------------------------------------------------------------------
PASS = FAIL = 0
def ok(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  [PASS] {name}")
    else:
        FAIL += 1; print(f"  [FAIL] {name}" + (f" - {detail}" if detail else ""))

class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.ok = 200 <= status < 300
        self.text = str(body)
        self.content = b""

    def json(self):
        return self._body


def offline_checks(wyzie, Movie, Episode):
    """Refusal mapping, matching and HI ordering against canned responses."""
    exc = sys.modules["subliminal.exceptions"]
    en = FakeLang("en")

    print("Refusal -> exception mapping (offline):")
    cases = [
        ((403, {"message": "Invalid API key"}), "AuthenticationError"),
        ((403, {"message": "Key on hold", "reinstate": "https://store.wyzie.io/verify"}), "WyzieKeyOnHold"),
        ((403, {"message": "Provider not available on free plan"}), "ConfigurationError"),
        ((402, {"message": "Pro key request balance exhausted", "topup": "https://store.wyzie.io/topup"}), "DownloadLimitExceeded"),
        ((429, {"message": "Daily request limit reached", "reset_at": 1790000000}), "DownloadLimitExceeded"),
        ((503, {"message": "Service temporarily unavailable"}), "ServiceUnavailable"),
        ((400, {"message": "Invalid source", "details": "Source must be one of ..."}), "ConfigurationError"),
    ]
    prov = wyzie.WyzieProvider(api_key="wyzie-" + "0" * 32, sources="alpha")
    prov.initialize()
    movie = Movie(imdb_id="tt0816692", tmdb_id=None, release_group="SPARKS", year=2014, resolution="1080p")
    for (status, body), want in cases:
        prov.session.get = lambda *a, s=status, b=body, **k: FakeResponse(s, b)
        try:
            prov.list_subtitles(movie, {en})
            ok(f"{status} {body['message']} -> {want}", False, "no exception")
        except Exception as e:
            ok(f"{status} {body['message']} -> {want}", e.__class__.__name__ == want, e.__class__.__name__)
    ok("held key is not an AuthenticationError", not issubclass(wyzie.WyzieKeyOnHold, exc.AuthenticationError))
    prov.session.get = lambda *a, **k: FakeResponse(400, {"message": "No subtitles found"})
    ok("400 No subtitles found -> []", prov.list_subtitles(movie, {en}) == [])

    print("\nRequest shape, matching and HI order (offline):")
    sent = {}
    items = [
        {"url": "u1", "language": "en", "isHearingImpaired": False, "release": "Interstellar.2014.1080p.BluRay.x264-SPARKS"},
        {"url": "u2", "language": "en", "isHearingImpaired": True, "release": "Interstellar.2014.720p.WEB-OTHER"},
    ]
    def fake_get(url, params=None, timeout=None):
        sent.update(params or {})
        return FakeResponse(200, items)
    hi = wyzie.WyzieProvider(api_key="wyzie-" + "0" * 32, prefer_hi=True)
    hi.initialize()
    hi.session.get = fake_get
    subs = hi.list_subtitles(movie, {en})
    ok("no hi param sent", "hi" not in sent, sent)
    ok("source defaults to all", sent.get("source") == "all", sent)
    ok("prefer_hi lists SDH first", [x.download_url for x in subs] == ["u2", "u1"])
    m = subs[1].get_matches(movie)
    ok("movie: imdb_id + title + year", {"imdb_id", "title", "year"} <= m, m)
    ok("movie: release name credited", {"resolution", "release_group"} <= m, m)
    ok("movie: other release not credited", "release_group" not in subs[0].get_matches(movie))

    ep = Episode(series_imdb_id="tt0944947", imdb_id="tt1480055", season=1, episode=1, release_group=None, year=2011, resolution=None)
    sent.clear()
    esubs = hi.list_subtitles(ep, {en})
    ok("episode searches by the SHOW's IMDb id", sent.get("id") == "tt0944947" and sent.get("season") == 1, sent)
    em = esubs[0].get_matches(ep)
    ok("episode: series_imdb_id + series + season + episode", {"series_imdb_id", "series", "season", "episode", "year"} <= em, em)
    tm = Movie(imdb_id=None, tmdb_id=157336, release_group=None, year=2014, resolution=None)
    sent.clear()
    tsubs = hi.list_subtitles(tm, {en})
    ok("movie without IMDb id searches by bare TMDB id", sent.get("id") == "157336", sent)
    ok("tmdb match credits title + year", {"title", "year"} <= tsubs[0].get_matches(tm))

    print("\nDownload refusals (offline):")
    sub = subs[0]
    hi.session.get = lambda *a, **k: FakeResponse(401, {"message": "Download link invalid or expired"})
    try:
        hi.download_subtitle(sub)
        ok("expired link: skipped, no exception", sub.content is None)
    except Exception as e:
        ok("expired link: skipped, no exception", False, e.__class__.__name__)
    hi.session.get = lambda *a, **k: FakeResponse(429, {"message": "Daily request limit reached"})
    try:
        hi.download_subtitle(sub)
        ok("download 429 -> DownloadLimitExceeded", False, "no exception")
    except Exception as e:
        ok("download 429 -> DownloadLimitExceeded", e.__class__.__name__ == "DownloadLimitExceeded", e.__class__.__name__)


def main():
    Movie, Episode = install_stubs()
    wyzie = load_provider()
    offline_checks(wyzie, Movie, Episode)
    if not KEY:
        print(f"\n{'='*40}\n{PASS} passed, {FAIL} failed (offline only; set WYZIE_KEY for the live tests)")
        sys.exit(1 if FAIL else 2)
    print()

    # ConfigurationError when no key
    print("Configuration:")
    try:
        wyzie.WyzieProvider(api_key=None)
        ok("raises without api_key", False)
    except Exception as e:
        ok("raises without api_key", e.__class__.__name__ == "ConfigurationError", e.__class__.__name__)

    prov = wyzie.WyzieProvider(api_key=KEY)
    prov.initialize()
    en = FakeLang("en")
    es = FakeLang("es")

    # Movie
    print("\nMovie list_subtitles:")
    movie = Movie(imdb_id="tt0816692", tmdb_id=None, release_group=None, year=2014, resolution=None)
    subs = prov.list_subtitles(movie, {en, es})
    ok("returns a list", isinstance(subs, list))
    ok("found >=1 subtitle", len(subs) >= 1, f"got {len(subs)}")
    if subs:
        s = subs[0]
        ok("subtitle has download_url", bool(getattr(s, "download_url", None)))
        ok("subtitle has a language", getattr(s, "language", None) is not None)
        m = s.get_matches(movie)
        ok("id match is credited (imdb_id, title, year)", {"imdb_id", "title", "year"} <= m, m)

    # Episode
    print("\nEpisode list_subtitles:")
    ep = Episode(series_imdb_id="tt0944947", season=1, episode=1, release_group=None, year=2011, resolution=None)
    esubs = prov.list_subtitles(ep, {en})
    ok("found >=1 subtitle for S1E1", len(esubs) >= 1, f"got {len(esubs)}")

    # Download
    print("\ndownload_subtitle:")
    if subs:
        prov.download_subtitle(subs[0])
        content = subs[0].content
        ok("content downloaded", content is not None and len(content) > 50,
           f"len={0 if content is None else len(content)}")

    # Bad key -> the API answers 403 and the provider raises AuthenticationError.
    print("\nInvalid key handling:")
    bad = wyzie.WyzieProvider(api_key="wyzie-00000000000000000000000000000000")
    bad.initialize()
    try:
        res = bad.list_subtitles(movie, {en})
        ok("bad key raises AuthenticationError (403)", False,
           f"no exception, got {len(res)} items")
    except Exception as e:
        ok("bad key raises AuthenticationError (403)",
           e.__class__.__name__ == "AuthenticationError", e.__class__.__name__)
    finally:
        bad.terminate()

    prov.terminate()
    print(f"\n{'='*40}\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
