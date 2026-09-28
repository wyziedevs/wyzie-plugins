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
# Every ISO 639-1 code babelfish knows. Anything else ("pb", "zt", "pt-BR")
# makes fromalpha2 raise, as babelfish's LanguageReverseError does.
ALPHA2 = set((
    "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv "
    "cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho "
    "hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku "
    "kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn "
    "no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm "
    "sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi "
    "vo wa wo xh yi yo za zh zu"
).split())
REAL3 = {"en": "eng", "es": "spa", "pt": "por", "zh": "zho", "he": "heb", "fr": "fra", "de": "deu"}
A2_TO_A3 = {c: REAL3.get(c, c + "x") for c in ALPHA2}
A3_TO_A2 = {v: k for k, v in A2_TO_A3.items()}


class FakeLang:
    """Stand-in for subzero's Language: babelfish's (alpha3, country, script)
    plus the forced / hi flags, equal only when all of them are."""
    def __init__(self, language, country=None, script=None, unknown=None, forced=False, hi=False):
        if language not in A3_TO_A2:
            raise ValueError("unknown language %r" % language)
        self.alpha3, self.country, self.script = language, country, script
        self.forced, self.hi = forced, hi
    @property
    def alpha2(self):
        return A3_TO_A2[self.alpha3]
    @property
    def basename(self):
        return self.alpha2 + ("-" + self.country if self.country else "")
    def __str__(self):
        return self.basename + (":forced" if self.forced else "")
    def __repr__(self):
        return "<Lang %s%s>" % (self, ":hi" if self.hi else "")
    def __hash__(self):
        return hash(str(self))
    def __eq__(self, other):
        return isinstance(other, FakeLang) and (self.alpha3, self.country, self.script, bool(self.forced), bool(self.hi)) \
            == (other.alpha3, other.country, other.script, bool(other.forced), bool(other.hi))
    @classmethod
    def fromalpha2(cls, code):
        if code not in A2_TO_A3:
            raise ValueError("%r is not an ISO 639-1 code" % code)
        return cls(A2_TO_A3[code])
    @classmethod
    def rebuild(cls, instance, **kw):
        state = {"country": instance.country, "script": instance.script, "hi": instance.hi, "forced": instance.forced}
        state.update(kw)
        return cls(instance.alpha3, **state)


def L(code, country=None, **kw):
    """A language by its ISO 639-1 code, e.g. L("pt", "BR") or L("en", hi=True)."""
    return FakeLang(A2_TO_A3[code], country, **kw)

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
    def __init__(self, status, body, content=b"", headers=None):
        self.status_code = status
        self._body = body
        self.ok = 200 <= status < 300
        self.text = str(body)
        self.content = content
        self.headers = headers or {}

    def json(self):
        return self._body


def offline_checks(wyzie, Movie, Episode):
    """Refusal mapping, matching and HI ordering against canned responses."""
    exc = sys.modules["subliminal.exceptions"]
    en = L("en")

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

    print("\nDownload options (offline):")
    from urllib.parse import parse_qs, urlsplit
    def q(url):
        return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
    pro = wyzie.WyzieProvider(api_key="wyzie-" + "0" * 32, dual_language="ES", strip_sdh="true",
                              mask_profanity=True, clean_format="1")
    pro.initialize()
    def make(lang, url="https://sub.wyzie.io/c/abc/id/123?format=srt&tok=t", fmt="srt", ai=False):
        return wyzie.WyzieSubtitle(L(lang), False, url, url, None, [], "charlie", fmt, ai)
    en_q = q(pro._download_url(make("en")))
    ok("en sub gets dual=es + sdh + clean + plain",
       en_q.get("dual") == "es" and en_q.get("sdh") == "strip" and en_q.get("clean") == "1" and en_q.get("plain") == "1", en_q)
    ok("existing params kept", en_q.get("tok") == "t" and en_q.get("format") == "srt", en_q)
    ok("es sub: no dual with itself", "dual" not in q(pro._download_url(make("es"))))
    ai_url = "https://sub.wyzie.io/translate?id=tt1&target=Spanish&tk=x"
    ok("AI link untouched", pro._download_url(make("es", url=ai_url, ai=True)) == ai_url)
    ok("image subtitle untouched", "sdh" not in pro._download_url(make("en", fmt="idx")))
    plain = wyzie.WyzieProvider(api_key="wyzie-" + "0" * 32)
    plain.initialize()
    ok("no options by default", plain._download_url(make("en")) == make("en").download_url)
    try:
        wyzie.WyzieProvider(api_key="wyzie-" + "0" * 32, dual_language="spanish")
        ok("bad dual_language -> ConfigurationError", False, "no exception")
    except Exception as e:
        ok("bad dual_language -> ConfigurationError", e.__class__.__name__ == "ConfigurationError", e.__class__.__name__)

    calls = []
    def paid_then_ok(url, timeout=None):
        calls.append(url)
        if len(calls) == 1:
            return FakeResponse(403, {"message": "Paid feature"})
        return FakeResponse(200, {}, content=b"1\n00:00:01,000 --> 00:00:02,000\nHi\n")
    pro.session.get = paid_then_ok
    s = make("en")
    pro.download_subtitle(s)
    retry = q(calls[-1]) if calls else {}
    ok("free key + Pro options: retried once", len(calls) == 2, calls)
    ok("retry drops dual/sdh/clean, keeps plain",
       not ({"dual", "sdh", "clean"} & set(retry)) and retry.get("plain") == "1", retry)
    ok("retry content saved", s.content is not None and len(s.content) > 10)
    ok("dual family: no dual=pt on a Brazilian (pb) subtitle",
       "dual" not in q(wyzie.WyzieProvider(api_key="wyzie-" + "0" * 32, dual_language="pt")._download_url(
           wyzie.WyzieSubtitle(L("pt", "BR"), False, "u", "https://sub.wyzie.io/c/a/id/1?tok=t", None, [], "charlie", "srt", False))))

    print("\nLanguages (offline):")
    langs = wyzie.WyzieProvider.languages
    ok("far more than the old 28 languages", len({l.basename for l in langs}) > 100, len({l.basename for l in langs}))
    ok("hr, sr, sl, fa and the regional pt-BR, zh-TW, es-MX offered",
       {L("hr"), L("sr"), L("sl"), L("fa"), L("pt", "BR"), L("zh", "TW"), L("es", "MX")} <= langs)
    ok("HI and forced variants offered (HI-only profiles reach Wyzie)",
       L("en", hi=True) in langs and L("en", forced=True) in langs and L("pt", "BR", hi=True) in langs)

    rows = [
        {"id": "1", "url": "https://sub.wyzie.io/c/a/id/1?tok=t1", "language": "pb", "source": "charlie", "isHearingImpaired": False},
        {"id": "2", "url": "https://sub.wyzie.io/c/a/id/2?tok=t1", "language": "zt", "source": "charlie", "isHearingImpaired": True},
        {"id": "3", "url": "https://sub.wyzie.io/c/a/id/3?tok=t1", "language": "ea", "source": "charlie", "isHearingImpaired": False},
        {"id": "4", "url": "https://sub.wyzie.io/c/a/id/4?tok=t1", "language": "sp", "source": "charlie", "isHearingImpaired": False},
        {"id": "5", "url": "https://sub.wyzie.io/c/a/id/5?tok=t1", "language": "pt-BR", "source": "india"},
        {"id": "6", "url": "https://sub.wyzie.io/c/a/id/6?tok=t1", "language": "en", "source": "charlie", "isHearingImpaired": False},
    ] + [{"id": "ai-" + c, "url": "https://sub.wyzie.io/translate?id=tt0816692&tk=t1&target=" + d, "language": c,
          "source": "ai", "ai": True, "isHearingImpaired": False}
         for c, d in (("en-AU", "English%20(Australia)"), ("en", "English"), ("es-AR", "Spanish%20(Argentina)"),
                      ("es-419", "Spanish%20(Latin%20America)"), ("es", "Spanish"), ("pt-BR", "Portuguese%20(Brazil)"),
                      ("pt", "Portuguese"), ("zh-TW", "Chinese%20(Taiwan)"), ("zh", "Chinese"))]
    sent = {}
    def canned(url, params=None, timeout=None):
        sent.clear(); sent.update(params or {})
        return FakeResponse(200, rows)
    aip = wyzie.WyzieProvider(api_key="wyzie-" + "0" * 32, ai_translate=True)
    aip.initialize()
    aip.session.get = canned
    wanted = {L("en"), L("en", hi=True), L("pt", "BR"), L("zh", "TW"), L("es", "MX"), L("es")}
    got = aip.list_subtitles(movie, wanted)
    ok("language= uses pb / zt / ea for the regional ones", sent.get("language") == "ea,en,es,pb,zt", sent.get("language"))
    real = {s.id: s for s in got if not s.ai}
    ok("pb / zt / ea / sp / pt-BR rows kept (fromalpha2 used to drop them)", len(real) == 6, sorted(real))
    ok("pb -> pt-BR, zt -> zh-TW, ea -> es-MX, sp -> es, pt-BR -> pt-BR",
       [real["charlie:%s" % i].language.basename for i in (1, 2, 3, 4)] + [real["india:5"].language.basename]
       == ["pt-BR", "zh-TW", "es-MX", "es", "pt-BR"])
    ai = {s.language.basename: urlsplit(s.download_url).query.split("target=")[1] for s in got if s.ai}
    ok("AI rows arrive, one per wanted language, the exact one",
       ai == {"en": "English", "pt-BR": "Portuguese%20(Brazil)", "zh-TW": "Chinese%20(Taiwan)",
              "es-MX": "Spanish%20(Latin%20America)", "es": "Spanish"}, ai)
    ok("stable id source:id (no tok=)", "charlie:1" in real and all("tok" not in i for i in real))
    ai_ids = [s.id for s in got if s.ai]
    ok("AI id is per title, not the bare 'ai-en'", all(i.startswith("ai:tt0816692:") for i in ai_ids), ai_ids)
    rows_t2 = [dict(r, url=r["url"].replace("tok=t1", "tok=t2").replace("tk=t1", "tk=t2")) for r in rows]
    aip.session.get = lambda url, params=None, timeout=None: FakeResponse(200, rows_t2)
    ok("same ids on the next search (blacklist matches)", sorted(s.id for s in aip.list_subtitles(movie, wanted)) == sorted(s.id for s in got))
    hi_sub = real["charlie:2"]
    ok("SDH row: language flagged hi, HI verifiable", hi_sub.language.hi and hi_sub.hearing_impaired_verifiable)
    ok("row without isHearingImpaired: HI not verifiable", not real["india:5"].hearing_impaired_verifiable)
    ok("AI rows: HI not verifiable", not any(s.hearing_impaired_verifiable for s in got if s.ai))
    sent.clear()
    aip.session.get = canned
    ok("forced-only request: nothing, no search", aip.list_subtitles(movie, {L("en", forced=True)}) == [] and not sent)

    print("\nEpisode numbers in release names (offline):")
    ep5 = Episode(series_imdb_id="tt1", season=1, episode=5, release_group=None, year=2020, resolution=None)
    def sub_for(*releases):
        return wyzie.WyzieSubtitle(L("en"), False, "u", "https://sub.wyzie.io/c/a/id/1", None, list(releases), "mike", "srt",
                                   False, search_imdb_id="tt1", season=1, episode=5)
    def se(*releases):
        m = sub_for(*releases).get_matches(ep5)
        return ("season" in m, "episode" in m)
    ok("S01E05 -> season + episode", se("Show.S01E05.1080p.WEB-GRP") == (True, True))
    ok("no numbers in the name -> still credited", se("Show.1080p.WEB-GRP") == (True, True))
    ok("S01E06 -> no episode", se("Show.S01E06.1080p.WEB-GRP") == (True, False))
    ok("S02E05 -> neither", se("Show.S02E05.1080p") == (False, False))
    ok("1x06 -> no episode", se("Show 1x06") == (True, False))
    ok("anime '- 06' -> no episode", se("[SubsPlease] Show - 06 (1080p) [ABCD1234].mkv") == (True, False))
    ok("anime '- 05v2' -> episode", se("[Group] Show - 05v2 [1080p].mkv") == (True, True))
    ok("one name right, another wrong -> credited", se("Show.S01E06", "Show.S01E05.WEB") == (True, True))
    ok("a year is not an episode", se("[Group] Show - 2020 Remaster [1080p]") == (True, True))
    abs17 = Episode(series_imdb_id="tt1", season=2, episode=5, absolute_episode=17, release_group=None, year=2020, resolution=None)
    m = wyzie.WyzieSubtitle(L("en"), False, "u", "https://sub.wyzie.io/c/a/id/1", None, ["[Group] Show - 17 [1080p]"], "mike",
                            "srt", False, search_imdb_id="tt1", season=2, episode=5).get_matches(abs17)
    ok("absolute episode number matches", "episode" in m, m)

    print("\nAI translate busy (offline):")
    ai_sub = next(s for s in got if s.ai)
    aip.session.get = lambda url, timeout=None: FakeResponse(503, {"message": "Too many translations"})
    try:
        aip.download_subtitle(ai_sub)
        ok("translate 503: skipped, provider not throttled", ai_sub.content is None)
    except Exception as e:
        ok("translate 503: skipped, provider not throttled", False, e.__class__.__name__)
    aip.session.get = lambda url, timeout=None: FakeResponse(503, {"message": "Service temporarily unavailable"})
    try:
        aip.download_subtitle(real["charlie:1"])
        ok("a /c/ 503 still raises ServiceUnavailable", False, "no exception")
    except Exception as e:
        ok("a /c/ 503 still raises ServiceUnavailable", e.__class__.__name__ == "ServiceUnavailable", e.__class__.__name__)


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
    en = L("en")
    es = L("es")

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

    # Pro options, live: an English episode subtitle saved with Spanish merged in.
    print("\nPro download options (live):")
    dual = wyzie.WyzieProvider(api_key=KEY, dual_language="es", strip_sdh=True)
    dual.initialize()
    seen = {}
    real_get = dual.session.get
    def recording_get(url, **kw):
        r = real_get(url, **kw)
        seen["url"], seen["dual"], seen["tx"] = url, r.headers.get("X-Dual"), r.headers.get("X-Subtitle-Transforms")
        return r
    dual.session.get = recording_get
    bb = Episode(series_imdb_id="tt0903747", season=1, episode=1, release_group=None, year=2008, resolution=None)
    dsubs = [x for x in dual.list_subtitles(bb, {en}) if "/c/" in x.download_url and not x.ai]
    ok("found an English /c/ subtitle", len(dsubs) >= 1, f"got {len(dsubs)}")
    if dsubs:
        dual.download_subtitle(dsubs[0])
        ok("dual download merged Spanish (X-Dual: es)", seen.get("dual") == "es", seen.get("dual"))
        ok("sdh applied too", "sdh=" in str(seen.get("tx")), seen.get("tx"))
        ok("dual content saved", dsubs[0].content is not None and len(dsubs[0].content) > 1000)
    dual.terminate()

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
