const { addonBuilder } = require('stremio-addon-sdk');

const WYZIE_BASE = process.env.WYZIE_BASE || 'https://sub.wyzie.io';

const manifest = {
  id: 'io.wyzie.subs',
  version: '1.2.0',
  name: 'Wyzie Subs',
  description:
    'Subtitles from OpenSubtitles, IndexSubtitle and, on Pro keys, five more providers, through the Wyzie Subs API. Get a free key at store.wyzie.io/redeem.',
  logo: 'https://i.postimg.cc/L5ppKYC5/cclogo.png',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: true, configurationRequired: true },
  config: [
    {
      key: 'apiKey',
      type: 'text',
      title: 'Wyzie API key (get one free at store.wyzie.io/redeem)',
      required: true,
    },
    {
      key: 'languages',
      type: 'text',
      title: 'Preferred languages (ISO 639-1, comma-separated). Leave blank for all.',
      required: false,
    },
    {
      key: 'hi',
      type: 'checkbox',
      title: 'Prefer hearing-impaired subtitles (listed first, others still shown)',
      required: false,
    },
  ],
};

// ISO 639-1 (what Wyzie returns) -> ISO 639-2/B, the three-letter code Stremio
// expects in `lang` to show the language name and auto-select the user's
// preferred subtitle language. Kept in step with worker.js. Unknown codes pass
// through unchanged.
const ISO639_2B = Object.fromEntries(
  (
    'en:eng es:spa fr:fre de:ger it:ita pt:por ru:rus ja:jpn ko:kor zh:chi ar:ara hi:hin nl:dut ' +
    'pl:pol tr:tur sv:swe da:dan fi:fin no:nor nb:nob nn:nno cs:cze el:gre he:heb th:tha id:ind ' +
    'vi:vie ro:rum hu:hun uk:ukr bg:bul hr:hrv sr:srp sk:slo sl:slv ms:may fa:per ca:cat et:est ' +
    'lv:lav lt:lit af:afr sq:alb am:amh hy:arm az:aze eu:baq be:bel bn:ben bs:bos my:bur km:khm ' +
    'ka:geo gl:glg gu:guj ha:hau is:ice ig:ibo ga:gle jv:jav kn:kan kk:kaz ky:kir lo:lao lb:ltz ' +
    'mk:mac mg:mlg ml:mal mt:mlt mi:mao mr:mar mn:mon ne:nep ps:pus pa:pan qu:que sm:smo gd:gla ' +
    'sn:sna sd:snd si:sin so:som st:sot su:sun sw:swa tg:tgk ta:tam tt:tat te:tel ti:tir to:ton ' +
    'tk:tuk ur:urd ug:uig uz:uzb cy:wel fy:fry xh:xho yi:yid yo:yor zu:zul ny:nya co:cos fo:fao ' +
    'fj:fij ht:hat ku:kur oc:oci or:ori rw:kin sa:san br:bre bo:tib dv:div gn:grn kl:kal ln:lin ' +
    'om:orm rm:roh ss:ssw ts:tso tn:tsn ve:ven wo:wol ak:aka lg:lug ki:kik ay:aym dz:dzo ee:ewe ' +
    'ff:ful tl:tgl la:lat eo:epo'
  )
    .split(' ')
    .map((pair) => pair.split(':')),
);

function stremioLang(code) {
  const raw = String(code || '').trim();
  const c = raw.toLowerCase();
  return ISO639_2B[c] || ISO639_2B[c.split(/[-_]/)[0]] || raw || 'eng';
}

const builder = new addonBuilder(manifest);

function parseStremioId(id) {
  // Movies:  tt1234567
  // Series:  tt1234567:1:2  (imdb : season : episode)
  const [imdb, season, episode] = id.split(':');
  return { imdb, season, episode };
}

// preferHi lists hearing-impaired subtitles first (stable, provider order kept
// otherwise). Wyzie's own `hi=true` is a hard filter, so it is never sent.
function mapToStremioSubs(items, preferHi) {
  const subs = items.filter((s) => s && s.url);
  if (preferHi) {
    subs.sort((a, b) => Number(!a.isHearingImpaired) - Number(!b.isHearingImpaired));
  }
  return subs.map((s) => ({
    id: String(s.id),
    url: s.url,
    lang: stremioLang(s.language || 'en'),
    // Stremio uses .display in its UI; pack source for transparency
    name: `${s.display || s.language}${s.isHearingImpaired ? ' (SDH)' : ''} / ${s.source || 'wyzie'}${s.ai ? ' (AI)' : ''}`,
  }));
}

function bareLink(url, fallback) {
  return String(url || fallback).replace(/^https?:\/\//, '');
}

function resetText(resetAt) {
  const t = Number(resetAt);
  if (!Number.isFinite(t) || t <= 0) return 'midnight UTC';
  return new Date(t * 1000).toISOString().slice(11, 16) + ' UTC';
}

// A single pseudo-subtitle telling the user why nothing is listed. The body
// decides which 403 it is: a held key carries `reinstate` / "Key on hold", a
// Pro-only source says "free plan", and only "Invalid API key" is a bad key.
function refusal(status, body) {
  const message = String((body && body.message) || '');
  const low = message.toLowerCase();
  let name = 'Wyzie: service error ' + status + '. Try again later.';
  let url = 'https://store.wyzie.io/contact';
  if (status === 403 && ((body && body.reinstate) || low.includes('key on hold'))) {
    name = 'Wyzie: key on hold. Verify your site at store.wyzie.io/verify (or contact support).';
    url = (body && body.reinstate) || 'https://store.wyzie.io/verify';
  } else if (status === 403 && low.includes('free plan')) {
    name = 'Wyzie: the chosen sources need a Pro key. Free keys get OpenSubtitles and IndexSubtitle.';
    url = 'https://store.wyzie.io/#plans';
  } else if (status === 403) {
    name = 'Wyzie: invalid API key. Re-check it in the addon settings.';
    url = 'https://store.wyzie.io/redeem';
  } else if (status === 401) {
    name = 'Wyzie: no API key sent. Check the addon settings.';
    url = 'https://store.wyzie.io/redeem';
  } else if (status === 402) {
    url = (body && body.topup) || 'https://store.wyzie.io/topup';
    name = 'Wyzie: Pro balance used up. Top up at ' + bareLink(url);
  } else if (status === 429) {
    url = (body && body.upgrade) || 'https://store.wyzie.io/#plans';
    name = 'Wyzie: daily limit reached, resets at ' + resetText(body && body.reset_at) + '. Upgrade at ' + bareLink(url);
  } else if (status === 503) {
    name = 'Wyzie: service briefly unavailable. Try again in a moment.';
  }
  return {
    subtitles: [{ id: 'wyzie-notice-s' + status, url, lang: 'eng', name }],
    cacheMaxAge: 60,
  };
}

builder.defineSubtitlesHandler(async ({ type, id, config }) => {
  const apiKey = config && config.apiKey;
  if (!apiKey) {
    return { subtitles: [] };
  }

  const { imdb, season, episode } = parseStremioId(id);
  if (!imdb || !imdb.startsWith('tt')) return { subtitles: [] };

  const url = new URL('/search', WYZIE_BASE);
  url.searchParams.set('id', imdb);
  url.searchParams.set('key', apiKey);
  if (type === 'series' && season && episode) {
    url.searchParams.set('season', season);
    url.searchParams.set('episode', episode);
  }
  if (config.languages) url.searchParams.set('language', config.languages);
  // No `hi` parameter: on Wyzie it drops every non-SDH subtitle. The "prefer
  // hearing-impaired" option orders SDH first instead (mapToStremioSubs).
  // Stremio's player handles srt and vtt natively; ask Wyzie to bias srt.
  url.searchParams.set('format', 'srt');
  // Query every enabled source the key can reach for the widest coverage.
  url.searchParams.set('source', 'all');

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'wyzie-stremio/1.2' },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      // A 400 "No subtitles found" is a normal empty result.
      if (res.status === 400) return { subtitles: [] };
      return refusal(res.status, body);
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.subtitles || [];
    return {
      subtitles: mapToStremioSubs(list, !!config.hi),
      cacheMaxAge: 60 * 60,
      staleRevalidate: 60 * 60 * 6,
      staleError: 60 * 60 * 24,
    };
  } catch (err) {
    // Only the error's name/code: the request URL carries the user's key.
    console.error('[wyzie-stremio] fetch failed', (err && err.cause && err.cause.code) || (err && err.name));
    return { subtitles: [] };
  }
});

module.exports = builder.getInterface();
