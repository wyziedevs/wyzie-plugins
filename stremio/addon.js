const { addonBuilder } = require('stremio-addon-sdk');

const WYZIE_BASE = process.env.WYZIE_BASE || 'https://sub.wyzie.io';
// Notice rows link to the hosted addon's /notice.srt (a one-cue SRT of the
// message), since the SDK server has no route of its own for it.
const NOTICE_BASE = process.env.WYZIE_NOTICE_BASE || 'https://stremio.wyzie.io';

// Config checks, kept in step with worker.js sanitizeConfig.
const API_KEY_RE = /^wyzie-[a-z0-9]{32}$/i;
const LANG_CODE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/;
const MAX_LANGUAGES = 150;

const manifest = {
  id: 'io.wyzie.subs',
  version: '1.4.1',
  name: 'Wyzie Subs',
  description:
    'Subtitles from OpenSubtitles, with cleanup options. Pro keys add more providers (including anime), dual-language subtitles, AI translation, SDH removal and profanity masking. Get a free key at store.wyzie.io/redeem.',
  logo: 'https://stremio.wyzie.io/logo.png',
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
    {
      key: 'plain',
      type: 'checkbox',
      title: 'Clean formatting (strip styling tags, fix overlapping lines)',
      required: false,
    },
    {
      key: 'ai',
      type: 'checkbox',
      title: 'AI-translate into my selected languages (Pro key only; adds one AI option per language)',
      required: false,
    },
    {
      key: 'dual',
      type: 'text',
      title: 'Dual subtitles: second language to show under each line, ISO 639-1 (Pro key only), e.g. es',
      required: false,
    },
    {
      key: 'sdh',
      type: 'checkbox',
      title: 'Remove hearing-impaired text like [door creaks] (Pro key only)',
      required: false,
    },
    {
      key: 'clean',
      type: 'checkbox',
      title: 'Mask strong profanity, English (Pro key only)',
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

// Regional languages Stremio's list (Stremio/nodejs-langs) names on their own:
// pob Portuguese (Brazil), zht Chinese (Traditional), spl Spanish (Latin
// America). Looked up before the base language. Kept in step with worker.js.
const STREMIO_REGIONAL = {
  pb: 'pob', 'pt-br': 'pob',
  zt: 'zht', 'zh-tw': 'zht', 'zh-hant': 'zht', 'zh-hk': 'zht', 'zh-mo': 'zht',
  ea: 'spl', 'es-419': 'spl', sp: 'spa', 'es-es': 'spa',
  ze: 'chi', zc: 'chi',
};

function stremioLang(code) {
  const raw = String(code || '').trim();
  const c = raw.toLowerCase().replace(/_/g, '-');
  if (STREMIO_REGIONAL[c]) return STREMIO_REGIONAL[c];
  const [base, region] = c.split('-');
  // Every other Spanish region (es-MX, es-AR, es-US, ...) is Latin American.
  if (base === 'es' && region) return 'spl';
  return ISO639_2B[c] || ISO639_2B[base] || raw || 'eng';
}

// Three-letter codes back to the two-letter code Wyzie takes ("eng", "pob").
const FROM_ISO639_2 = Object.fromEntries([
  ...Object.entries(ISO639_2B).map(([two, three]) => [three, two]),
  ...'fra:fr deu:de zho:zh nld:nl ces:cs ron:ro fas:fa msa:ms ell:el isl:is mkd:mk slk:sk cym:cy mya:my kat:ka bod:bo mri:mi sqi:sq hye:hy eus:eu fil:tl pob:pb zht:zt zhe:zh spl:es'
    .split(' ')
    .map((pair) => pair.split(':')),
]);

// A configured code as Wyzie's `language` param takes it (two letters only,
// anything else is a 400): pt-BR -> pb, zh-TW / zh-Hant -> zt, other regions
// dropped (es-MX -> es), three letters mapped back. null when there is none.
function apiLang(code) {
  const c = String(code || '').trim().toLowerCase().replace(/_/g, '-');
  if (/^[a-z]{2}$/.test(c)) return c;
  if (/^[a-z]{3}$/.test(c)) return FROM_ISO639_2[c] || null;
  const m = c.match(/^([a-z]{2})((?:-[a-z0-9]{2,8})+)$/);
  if (!m) return null;
  const tags = m[2].slice(1).split('-');
  if (m[1] === 'pt' && tags.includes('br')) return 'pb';
  if (m[1] === 'zh' && tags.some((t) => t === 'hant' || t === 'tw' || t === 'hk' || t === 'mo')) return 'zt';
  return m[1];
}

// A configured code as kept: the API code, or the regional code when the API
// has none for it (es-mx), so the AI row can still honour it.
function configLang(code) {
  const c = String(code || '').trim().toLowerCase().replace(/_/g, '-');
  if (!LANG_CODE_RE.test(c)) return null;
  const api = apiLang(c);
  if (!api) return null;
  return c.includes('-') && api === c.split('-')[0] ? c : api;
}

function baseLang(code) {
  return String(code || '').trim().toLowerCase().split(/[-_]/)[0];
}

// OpenSubtitles' regional codes and the language each belongs to.
const OS_REGIONAL_BASE = { pb: 'pt', zt: 'zh', ze: 'zh', zc: 'zh', ea: 'es', sp: 'es', iw: 'he' };

function langFamily(code) {
  const c = baseLang(code);
  return OS_REGIONAL_BASE[c] || c;
}

// The AI rows (by language code) that stand for a configured code, best first.
const AI_TARGETS = {
  pb: ['pt-br'],
  zt: ['zh-tw', 'zh-hant', 'zh-hk'],
  ea: ['es-419', 'es-mx'],
  sp: ['es-es', 'es'],
  ze: ['zh-hans', 'zh-cn', 'zh'],
  zc: ['zh-hk', 'zh-hant'],
};

function aiTargets(code) {
  const c = String(code || '').trim().toLowerCase();
  return AI_TARGETS[c] || (c.includes('-') ? [c, baseLang(c)] : [c]);
}

// One AI row per configured language: the row whose code IS that language
// (en -> "en", pb -> "pt-BR"), a regional variant only when there is none. The
// API lists variants before the plain language, so the first row per language
// was "English (Australia)" for en.
function pickAiRows(rows, langs) {
  const byCode = new Map();
  for (const r of rows) {
    const c = String(r.language || '').trim().toLowerCase();
    if (c && !byCode.has(c)) byCode.set(c, r);
  }
  const picked = new Set();
  for (const code of langs) {
    let row = aiTargets(code).map((c) => byCode.get(c)).find((r) => r && !picked.has(r));
    if (!row) {
      const family = langFamily(code);
      row = rows.find((r) => langFamily(r.language) === family && !picked.has(r));
    }
    if (row) picked.add(row);
  }
  return picked;
}

const on = (v) => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';

// The SDK hands over whatever JSON the install link carried, so keep only the
// known fields in their expected shape (as worker.js sanitizeConfig does): a
// malformed key is flagged badKey, languages are normalized and de-duplicated.
function sanitizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  if (API_KEY_RE.test(apiKey)) out.apiKey = apiKey;
  else if (apiKey) out.badKey = true;
  const rawLangs = Array.isArray(cfg.languages)
    ? cfg.languages
    : typeof cfg.languages === 'string' ? cfg.languages.split(',') : [];
  const langs = [];
  for (const l of rawLangs) {
    if (typeof l !== 'string') continue;
    const code = configLang(l);
    if (code && !langs.includes(code)) langs.push(code);
    if (langs.length >= MAX_LANGUAGES) break;
  }
  out.langs = langs;
  for (const k of ['hi', 'ai', 'sdh', 'clean', 'plain']) out[k] = on(cfg[k]);
  const dual = typeof cfg.dual === 'string' ? cfg.dual.trim().toLowerCase() : '';
  out.dual = /^[a-z]{2}$/.test(dual) ? dual : '';
  return out;
}

const builder = new addonBuilder(manifest);

function parseStremioId(id) {
  // Movies:  tt1234567
  // Series:  tt1234567:1:2  (imdb : season : episode)
  const [imdb, season, episode] = id.split(':');
  return { imdb, season, episode };
}

// Map Wyzie /search rows to Stremio subtitle entries.
//   preferHi    list hearing-impaired (SDH) subtitles first (Wyzie's own
//               hi=true is a hard filter, so it is never sent).
//   ai          keep AI-translation rows (source "ai"); off by default so the
//               picker is not flooded with ~135 machine rows.
//   langs       the language codes the user configured (configLang form); AI
//               rows are emitted only for these, one per language, the exact
//               one (pickAiRows). They also pick which subtitles get a dual
//               copy (English when none are set).
//   contentKey  short per-title key mixed into every id. Without it the AI rows
//               (Wyzie id "ai-<lang>") get the same Stremio id on every title,
//               so Stremio serves a translation cached from another show, the
//               "wrong subtitle for the wrong show" bug.
//   options     Wyzie download options for real (/c/) links ({ sdh: 'strip',
//               clean: '1', plain: '1' }); AI rows are /translate links.
//   dual        two-letter code: the best DUAL_MAX real subtitles in the user's
//               languages (not the second one) also get a "+ <Language>" copy
//               with dual= set.
const DUAL_MAX = 8;
const TEXT_FORMAT_RE = /^(srt|vtt|webvtt|ass|ssa|sub|ttml|dfxp|txt)$/i;

function isDownloadLink(rawUrl) {
  try {
    return new URL(rawUrl).pathname.startsWith('/c/');
  } catch {
    return false;
  }
}

function withParams(rawUrl, params) {
  try {
    const u = new URL(rawUrl);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// The file in the charset Wyzie reports for it (the url already carries an
// `encoding`; the item's field is authoritative), as worker.js does.
function withEncoding(rawUrl, encoding) {
  return encoding ? withParams(rawUrl, { encoding }) : rawUrl;
}

// OpenSubtitles' regional codes as BCP 47 tags, which Intl can name.
const OS_REGIONAL_TAG = { pb: 'pt-BR', zt: 'zh-Hant', ea: 'es-419' };

function languageName(code) {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(OS_REGIONAL_TAG[code] || code);
    if (name && name.toLowerCase() !== code) return name;
  } catch {}
  return String(code).toUpperCase();
}

// Release matching against the file Stremio says is playing (extra.filename),
// kept in step with worker.js: one point per shared quality/source/codec
// token, five for the same release group.
const RELEASE_TOKEN_RE = /\b(?:2160p|1080p|720p|480p|hdr(?:10)?|dv|dolby|imax|remux|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|web|hdtv|hdrip|dvdrip|amzn|nf|nflx|dsnp|hmax|hulu|itunes|atvp|apple|x264|x265|h264|h265|hevc|avc|10bit|8bit|aac|ac3|dts|ddp?5?\.?1|truehd|atmos)\b/gi;

function releaseTokens(text) {
  return new Set(String(text || '').toLowerCase().match(RELEASE_TOKEN_RE) || []);
}

function releaseGroup(text) {
  const m = String(text || '').match(/-([A-Za-z0-9]+)(?:\.[a-z0-9]{2,4})?$/i);
  return m ? m[1].toLowerCase() : null;
}

function scoreSub(sub, filename) {
  if (!filename) return 0;
  const want = releaseTokens(filename);
  const wantGroup = releaseGroup(filename);
  const names = [sub.release, sub.fileName, ...(Array.isArray(sub.releases) ? sub.releases : [])].filter(Boolean);
  if (!names.length) return 0;
  let score = 0;
  for (const t of releaseTokens(names.join(' '))) if (want.has(t)) score += 1;
  if (wantGroup && names.some((n) => releaseGroup(n) === wantGroup)) score += 5;
  return score;
}

function mapToStremioSubs(items, preferHi, ai, langs, contentKey, options, dual, filename) {
  const key = String(contentKey || '').replace(/[^a-z0-9]+/gi, '.');
  const usedIds = new Set();
  const seenUrls = new Set();
  const isAiRow = (s) => !!s && (s.ai === true || s.source === 'ai');
  const aiRows = ai && langs.length ? pickAiRows(items.filter((s) => isAiRow(s) && s.url), langs) : new Set();
  // Dual copies only for subtitles in the user's languages (English if unset).
  const dualFamilies = new Set(langs.length ? langs.map(langFamily) : ['en']);
  dualFamilies.delete(langFamily(dual));
  const out = [];
  items.forEach((s, idx) => {
    if (!s || !s.url) return;
    const isAi = isAiRow(s);
    if (isAi && !aiRows.has(s)) return;
    const fileUrl = isAi ? s.url : withEncoding(s.url, s.encoding);
    if (seenUrls.has(fileUrl)) return; // collapse duplicate files
    seenUrls.add(fileUrl);
    const aiCode = String(s.language || 'en').trim().toLowerCase();
    let id = 'wyzie-' + (key ? key + '-' : '') + (isAi ? 'ai-' + aiCode : (s.source || 'src') + '-' + (s.id != null ? s.id : idx));
    if (usedIds.has(id)) id += '-' + idx;
    usedIds.add(id);
    const optionable = !isAi && isDownloadLink(fileUrl) && TEXT_FORMAT_RE.test(String(s.format || 'srt'));
    const url = optionable && options ? withParams(fileUrl, options) : fileUrl;
    const score = isAi ? 0 : scoreSub(s, filename);
    out.push({
      isAi,
      isHi: !!s.isHearingImpaired,
      idx,
      score,
      dualUrl: dual && optionable && dualFamilies.has(langFamily(s.language || 'en')) ? withParams(url, { dual }) : null,
      entry: {
        id,
        url,
        lang: stremioLang(s.language || 'en'),
        // Stremio uses .display in its UI; pack source for transparency. A ✓
        // marks subtitles made for the same release as the playing file.
        name: isAi
          ? `${s.display || s.language} · AI translated / wyzie`
          : `${score >= 5 ? '✓ ' : ''}${s.display || s.language}${s.isHearingImpaired && !(options && options.sdh) ? ' (SDH)' : ''} / ${s.source || 'wyzie'}`,
      },
    });
  });
  // Real subs before AI, then SDH first when preferred, then the best release
  // match, provider order otherwise.
  out.sort((a, b) => Number(a.isAi) - Number(b.isAi)
    || (preferHi ? Number(!a.isHi) - Number(!b.isHi) : 0)
    || b.score - a.score
    || a.idx - b.idx);
  const entries = out.map((x) => x.entry);
  if (!dual) return entries;
  // Bilingual copies of the best-ranked subtitles, listed first.
  const second = languageName(dual);
  const dualRows = out
    .filter((x) => x.dualUrl)
    .slice(0, DUAL_MAX)
    .map((x) => ({
      id: x.entry.id + '-dual-' + dual,
      url: x.dualUrl,
      lang: x.entry.lang,
      name: x.entry.name.replace(/ \/ ([^/]*)$/, ` + ${second} / $1`),
    }));
  return dualRows.concat(entries);
}

function bareLink(url, fallback) {
  return String(url || fallback).replace(/^https?:\/\//, '');
}

function resetText(resetAt) {
  const t = Number(resetAt);
  if (!Number.isFinite(t) || t <= 0) return 'midnight UTC';
  return new Date(t * 1000).toISOString().slice(11, 16) + ' UTC';
}

// A status/error shown inside Stremio's subtitle picker, as worker.js does:
// the message is the entry's `lang` (what Stremio displays) and its url is a
// one-cue SRT of the same text, so selecting it shows the message on screen.
function notice(key, text, cacheMaxAge = 60) {
  return {
    subtitles: [{ id: 'wyzie-notice-' + key, url: NOTICE_BASE + '/notice.srt?m=' + encodeURIComponent(text), lang: text, name: text }],
    cacheMaxAge,
  };
}

// What to tell the user about a refused /search, kept in step with worker.js
// refusalNotice. The body decides which 403 it is: a held key carries
// `reinstate` / "Key on hold", a Pro-only source says "free plan", and only
// "Invalid API key" is a bad key.
function refusal(status, body) {
  const message = String((body && body.message) || '');
  const low = message.toLowerCase();
  if (status === 403) {
    if ((body && body.reinstate) || low.includes('key on hold')) {
      return notice('held', 'Wyzie: key on hold. Verify your site at store.wyzie.io/verify (or contact support).');
    }
    if (low.includes('free plan')) {
      return notice('pro', 'Wyzie: the chosen sources need a Pro key. Free keys get OpenSubtitles.');
    }
    if (low.includes('invalid api key')) {
      return notice('s403', 'Wyzie: invalid API key. Re-check it in the addon settings.');
    }
    return notice('s403', 'Wyzie: request refused (' + (message || '403') + ').');
  }
  if (status === 401) return notice('s401', 'Wyzie: no API key sent. Check the addon settings.');
  if (status === 402) {
    return notice('s402', 'Wyzie: Pro balance used up. Top up at ' + bareLink(body && body.topup, 'store.wyzie.io/topup'));
  }
  if (status === 429) {
    return notice('s429', 'Wyzie: daily limit reached, resets at ' + resetText(body && body.reset_at)
      + '. Upgrade at ' + bareLink(body && body.upgrade, 'store.wyzie.io/#plans'));
  }
  if (status === 503) return notice('s503', 'Wyzie: service briefly unavailable. Try again in a moment.');
  if (status === 400) {
    // A request Wyzie can't take (e.g. "Invalid language format"): its words.
    return notice('s400', 'Wyzie: request rejected (' + (message || '400') + '). Check the addon settings.');
  }
  return notice('s' + status, 'Wyzie: service error ' + status + '. Try again later.');
}

builder.defineSubtitlesHandler(async ({ type, id, extra, config: rawConfig }) => {
  const config = sanitizeConfig(rawConfig);
  if (config.badKey) return notice('s403', 'Wyzie: invalid API key. Re-check it in the addon settings.');
  if (!config.apiKey) return notice('nokey', 'Wyzie: no API key set. Open the addon settings to add one.');

  const { imdb, season, episode } = parseStremioId(id);
  if (!imdb || !imdb.startsWith('tt')) return { subtitles: [] };
  // A series needs both, or /search answers 400 "Both season and episode are
  // required" (and without them it would be searched as a movie).
  if (type === 'series' && (!season || !episode)) {
    return notice('noep', 'Wyzie: could not identify the episode. Restart the stream and try again.');
  }

  const url = new URL('/search', WYZIE_BASE);
  url.searchParams.set('id', imdb);
  url.searchParams.set('key', config.apiKey);
  if (type === 'series') {
    url.searchParams.set('season', season);
    url.searchParams.set('episode', episode);
  }
  // The configured codes, as the two-letter codes the API takes (es-mx -> es).
  const apiLangs = [...new Set(config.langs.map(apiLang).filter(Boolean))];
  if (apiLangs.length) url.searchParams.set('language', apiLangs.join(','));
  // No `hi` parameter: on Wyzie it drops every non-SDH subtitle. The "prefer
  // hearing-impaired" option orders SDH first instead (mapToStremioSubs).
  // Stremio's player handles srt and vtt natively; ask Wyzie to bias srt.
  url.searchParams.set('format', 'srt');
  // Query every enabled source the key can reach for the widest coverage.
  url.searchParams.set('source', 'all');

  const contentKey = [imdb, season, episode].filter(Boolean).join('.');

  try {
    // Cap the wait so a stuck upstream gives a notice quickly instead of
    // holding the player until Stremio gives up.
    const res = await fetch(url, {
      headers: { 'User-Agent': 'wyzie-stremio/1.4.1' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      // Wyzie answers 400 "No subtitles found" rather than an empty list.
      if (res.status === 400 && /no subtitles found/i.test(String((body && body.message) || ''))) {
        return notice('empty', 'Wyzie: no subtitles found for this title.', 600);
      }
      return refusal(res.status, body);
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.subtitles || [];
    const options = {};
    if (config.sdh) options.sdh = 'strip';
    if (config.clean) options.clean = '1';
    if (config.plain) options.plain = '1';
    const subtitles = mapToStremioSubs(list, config.hi, config.ai, config.langs, contentKey,
      Object.keys(options).length ? options : null, config.dual, extra && extra.filename);
    if (!subtitles.length) return notice('empty', 'Wyzie: no subtitles found for this title.', 600);
    return {
      subtitles,
      cacheMaxAge: 60 * 60,
      staleRevalidate: 60 * 60 * 6,
      staleError: 60 * 60 * 24,
    };
  } catch (err) {
    // Only the error's name/code: the request URL carries the user's key.
    console.error('[wyzie-stremio] fetch failed', (err && err.cause && err.cause.code) || (err && err.name));
    return notice('neterr', 'Wyzie: could not reach the subtitle service. Try again later.', 30);
  }
});

module.exports = builder.getInterface();
