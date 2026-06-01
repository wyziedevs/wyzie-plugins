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
    class AuthenticationError(Exception): pass
    class ConfigurationError(Exception): pass
    sub_exc.AuthenticationError = AuthenticationError
    sub_exc.ConfigurationError = ConfigurationError
    sys.modules["subliminal.exceptions"] = sub_exc

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
    sp_subtitle.Subtitle = Subtitle
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

def main():
    if not KEY:
        print("ERROR: set WYZIE_KEY"); sys.exit(2)

    Movie, Episode = install_stubs()
    wyzie = load_provider()

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
    movie = Movie(imdb_id="tt0816692", release_group=None)
    subs = prov.list_subtitles(movie, {en, es})
    ok("returns a list", isinstance(subs, list))
    ok("found >=1 subtitle", len(subs) >= 1, f"got {len(subs)}")
    if subs:
        s = subs[0]
        ok("subtitle has download_url", bool(getattr(s, "download_url", None)))
        ok("subtitle has a language", getattr(s, "language", None) is not None)

    # Episode
    print("\nEpisode list_subtitles:")
    ep = Episode(series_imdb_id="tt0944947", season=1, episode=1, release_group=None)
    esubs = prov.list_subtitles(ep, {en})
    ok("found >=1 subtitle for S1E1", len(esubs) >= 1, f"got {len(esubs)}")

    # Download
    print("\ndownload_subtitle:")
    if subs:
        prov.download_subtitle(subs[0])
        content = subs[0].content
        ok("content downloaded", content is not None and len(content) > 50,
           f"len={0 if content is None else len(content)}")

    # Bad key -> AuthenticationError on 401 (or empty list if API returns 403)
    print("\nInvalid key handling:")
    bad = wyzie.WyzieProvider(api_key="wyzie-thiskeyisnotrealatallnope0000000")
    bad.initialize()
    try:
        res = bad.list_subtitles(movie, {en})
        ok("bad key returns empty (403 path)", res == [], f"got {len(res)} items")
    except Exception as e:
        ok("bad key raises AuthenticationError (401 path)",
           e.__class__.__name__ == "AuthenticationError", e.__class__.__name__)
    finally:
        bad.terminate()

    prov.terminate()
    print(f"\n{'='*40}\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
