/**
 * Wyzie Subs - Stremio addon as a Cloudflare Worker.
 *
 * Routes (Stremio configurable-addon convention):
 *   GET /                          -> config / install UI (HTML)
 *   GET /configure                 -> config / install UI (HTML)
 *   GET /:config/configure         -> config UI prefilled for re-configuring
 *   GET /manifest.json             -> base manifest (configurationRequired)
 *   GET /:config/manifest.json     -> configured manifest (installable)
 *   GET /:config/subtitles/:type/:id.json
 *
 * The user's options (API key, languages, HI) are URL-encoded JSON in the
 * first path segment, so no secrets ever live in env vars or code.
 */

import LOGO_PNG from './logo.png';

const WYZIE_BASE = 'https://sub.wyzie.io';
const WYZIE_API = 'https://api.wyzie.io';

// Every issued Wyzie key is `wyzie-` + 32 lowercase-alphanumeric chars. Rejecting
// anything else up front lets the config page tell the user the key is malformed
// without any network round-trip.
const API_KEY_RE = /^wyzie-[a-z0-9]{32}$/i;

// Language codes accepted in the config: ISO 639-1/-2 with optional region or
// script subtags ("en", "pt-br", "es-419", "zh-hant-tw"). Each is normalized to
// what Wyzie's `language` param takes (apiLang) or dropped. The cap stays above
// the ~125 languages the configure page offers, so a long hand-picked list is
// never cut short.
const LANG_CODE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/;
const MAX_LANGUAGES = 150;

const MANIFEST = {
  id: 'io.wyzie.subs',
  version: '1.4.1',
  name: 'Wyzie Subs',
  description:
    'Subtitles from OpenSubtitles, matched to your release, with cleanup options. Pro keys add more providers (including anime), dual-language subtitles, AI translation, SDH removal and profanity masking. Get a free key at store.wyzie.io/#plans.',
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
      title: 'Wyzie API key (get one free at store.wyzie.io/#plans)',
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

// ISO 639-1 (what Wyzie returns in `language`) -> ISO 639-2/B, the three-letter
// code Stremio expects in a subtitle's `lang`. With it Stremio shows the
// language name instead of a bare code and can auto-select the user's preferred
// subtitle language. Unknown codes pass through unchanged.
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
// America). Looked up before the base language, so a pt-BR row is not just
// "por". Keys are OpenSubtitles' codes (pb, zt, ea, sp, ze, zc) and the AI rows'.
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

// Three-letter codes (ISO 639-2/B and /T, and Stremio's regional ones) back to
// the two-letter code Wyzie takes, so a hand-typed "eng" or "pob" still works.
const FROM_ISO639_2 = Object.fromEntries([
  ...Object.entries(ISO639_2B).map(([two, three]) => [three, two]),
  ...'fra:fr deu:de zho:zh nld:nl ces:cs ron:ro fas:fa msa:ms ell:el isl:is mkd:mk slk:sk cym:cy mya:my kat:ka bod:bo mri:mi sqi:sq hye:hy eus:eu fil:tl pob:pb zht:zt zhe:zh spl:es'
    .split(' ')
    .map((pair) => pair.split(':')),
]);

// A configured language code as Wyzie's `language` param takes it: two letters
// only (anything else is a 400 "Invalid language format", which sinks the whole
// list). pt-BR and zh-TW become OpenSubtitles' own pb / zt; any other region or
// script is dropped (es-419 and es-MX -> es, which also brings Latin American
// Spanish); three-letter codes map back to two. null when there is no match.
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

// A configured code as kept in the config: the API code, except that a region
// the API has no code for stays (es-mx), so the AI row can still honour it.
function configLang(code) {
  const c = String(code || '').trim().toLowerCase().replace(/_/g, '-');
  if (!LANG_CODE_RE.test(c)) return null;
  const api = apiLang(c);
  if (!api) return null;
  return c.includes('-') && api === c.split('-')[0] ? c : api;
}

// OpenSubtitles' regional codes and the language each belongs to.
const OS_REGIONAL_BASE = { pb: 'pt', zt: 'zh', ze: 'zh', zc: 'zh', ea: 'es', sp: 'es', iw: 'he' };

// The language a code belongs to: "pt" for pt, pb and pt-BR.
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

// The AI rows to offer: one per configured language, the row whose code IS that
// language (en -> "en", pb -> "pt-BR", es-mx -> "es-MX"), and a regional variant
// only when there is no such row. The API lists variants before the plain
// language (en-AU ... en-US, then en), so keeping the first row per language
// offered "English (Australia)" for en and "Spanish (Argentina)" for es.
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function html(body) {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

// JSON for an inline <script>. JSON.stringify leaves `</script>` and `<!--`
// intact, which would end the script block early; escaping <, > and & as
// \u escapes keeps the value identical to JS while making it inert to the HTML
// parser. U+2028/U+2029 are escaped for engines that treat them as newlines.
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Standalone configure / install page. `prefill` pre-populates the form when a
// user re-opens config from an already-installed addon. The inline script uses
// string concatenation (no template literals) so it can be embedded safely.
// `prefill` comes from the request URL: only the sanitized fields are embedded,
// and only through scriptJson.
function configPage(prefill) {
  const cfg = sanitizeConfig(prefill);
  const fields = {};
  if (cfg.apiKey) fields.apiKey = cfg.apiKey;
  if (cfg.languages) fields.languages = cfg.languages;
  for (const k of ['hi', 'ai', 'sdh', 'clean', 'plain']) if (cfg[k]) fields[k] = true;
  if (cfg.dual) fields.dual = cfg.dual;
  const PREFILL = scriptJson(fields);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0b0b0b" />
<title>Wyzie Subs for Stremio</title>
<meta name="description" content="Install Wyzie Subs in Stremio. Free subtitles in 125 languages." />
<link rel="icon" href="/logo.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="preconnect" href="https://flagcdn.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
  /* Store component system (PricingCard / Button / Input / SectionHeader),
     recolored to the Wyzie Subs dark theme. */
  :root {
    --bg: #0b0b0b; --card: #111111; --accent: #181818;
    --border-200: #262626; --border-300: #333333;
    --primary-400: #60a5fa; --primary-500: #3b82f6; --primary-600: #2563eb; --primary-700: #1d4ed8;
    --primary-ring: rgba(37,99,235,0.35); --primary-soft: rgba(37,99,235,0.14);
    --type-emphasized: #e0e0e0; --type-subheader: #d0d0d0; --type-dimmed: #c0c0c0; --type-footer: #6b7280;
    --success-500: #10b981;
    --shadow-card: 0 1px 3px rgba(0,0,0,0.45), 0 1px 2px rgba(0,0,0,0.35);
    --shadow-card-hover: 0 10px 28px -8px rgba(0,0,0,0.7), 0 2px 6px rgba(0,0,0,0.4);
    --ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: var(--bg);
    color: var(--type-emphasized);
    font-family: "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 15px; line-height: 1.6;
    position: relative;
    display: flex; align-items: center; justify-content: center;
    padding: 36px 18px;
    -webkit-font-smoothing: antialiased;
  }
  /* Animated particle field behind the card */
  #bg { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; display: block; }

  /* PricingCard: rounded-xl (12px), border, bg-card, shadow-card, p-6.
     This is the primary action, so it borrows the isPrimary accent ring. */
  .card {
    width: 100%; max-width: 460px;
    background: var(--card);
    border: 1px solid var(--border-200);
    border-radius: 12px;
    padding: 28px 28px 20px;
    position: relative; z-index: 1;
    box-shadow: var(--shadow-card-hover);
  }

  .brand { display: flex; align-items: center; gap: 11px; margin-bottom: 16px; }
  .brand img { width: 36px; height: 36px; border-radius: 8px; }
  .brand h1 { font-size: 18px; font-weight: 700; margin: 0; letter-spacing: -0.01em; line-height: 1.1; color: var(--type-emphasized); }
  .brand h1 span { color: var(--primary-600); }
  .tag { font-size: 11px; color: var(--type-footer); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 2px; }

  /* SectionHeader typography */
  .title { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 8px; color: var(--type-emphasized); }
  .lead { color: var(--type-dimmed); font-size: 14px; margin: 0 0 22px; line-height: 1.6; }
  .lead a, .hint a { color: var(--primary-500); text-decoration: none; }
  .lead a:hover, .hint a:hover { text-decoration: underline; }

  /* Input (store: h-10, rounded-lg, border-300, focus primary-500) */
  .field { margin-bottom: 18px; }
  label { display: block; font-size: 13px; font-weight: 600; color: var(--type-subheader); margin: 0 0 7px; }
  label .opt { color: var(--type-footer); font-weight: 500; }
  .input-wrap { position: relative; }
  .input-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--type-footer); pointer-events: none; display: flex; }
  input[type=text] {
    display: block; width: 100%; height: 40px; padding: 10px 12px; font-size: 14px;
    font-family: inherit; color: var(--type-emphasized); background: #0c0c0c;
    border: 1px solid var(--border-300); border-radius: 8px;
    outline: none; transition: border-color .2s var(--ease-out-quint), box-shadow .2s var(--ease-out-quint);
  }
  input.has-icon { padding-left: 36px; }
  input[type=text]::placeholder { color: var(--type-footer); }
  input[type=text]:focus { border-color: var(--primary-500); box-shadow: 0 0 0 3px var(--primary-ring); }
  .hint { font-size: 12px; color: var(--type-footer); margin-top: 7px; }
  .hint[hidden] { display: none; }
  .key-msg { color: #fbbf24; }

  /* API-key validation status, shown inside the input on the right */
  .input-status { position: absolute; right: 11px; top: 50%; transform: translateY(-50%); display: none; align-items: center; pointer-events: none; }
  .input-status:not([hidden]) { display: flex; }
  .input-status .svg { width: 16px; height: 16px; flex-shrink: 0; }
  .input-status.checking { color: var(--type-footer); }
  .input-status.valid { color: var(--success-500); }
  .input-status.invalid { color: #f87171; }
  .input-status.warn { color: #fbbf24; }
  input.has-status { padding-right: 38px; }
  .spin { animation: wz-spin 0.7s linear infinite; transform-origin: center; }
  @keyframes wz-spin { to { transform: rotate(360deg); } }

  /* Language multi-select with flags */
  .ms { position: relative; }
  .ms-control {
    display: flex; align-items: center; gap: 8px; min-height: 40px; width: 100%;
    padding: 5px 10px; background: #0c0c0c; border: 1px solid var(--border-300);
    border-radius: 8px; cursor: pointer;
    transition: border-color .2s var(--ease-out-quint), box-shadow .2s var(--ease-out-quint);
  }
  .ms-control:focus-visible { outline: none; border-color: var(--primary-500); box-shadow: 0 0 0 3px var(--primary-ring); }
  .ms.open .ms-control { border-color: var(--primary-500); box-shadow: 0 0 0 3px var(--primary-ring); }
  .ms-chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; align-items: center; min-width: 0; }
  .ms-ph { color: var(--type-footer); font-size: 14px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; background: var(--accent);
    border: 1px solid var(--border-300); border-radius: 6px; padding: 3px 4px 3px 6px;
    font-size: 12px; color: var(--type-emphasized);
  }
  .flag { border-radius: 2px; display: block; flex-shrink: 0; }
  .chip-code { font-weight: 600; letter-spacing: 0.02em; }
  .chip-count { padding: 3px 9px; font-weight: 600; }
  .chip-x {
    display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
    padding: 0; border: none; background: transparent; color: var(--type-footer);
    cursor: pointer; border-radius: 4px; transition: color .15s var(--ease-out-quint), background-color .15s var(--ease-out-quint);
  }
  .chip-x:hover { color: var(--type-emphasized); background: rgba(255,255,255,0.06); }
  .chip-x .svg { width: 12px; height: 12px; }
  .ms-caret { color: var(--type-footer); flex-shrink: 0; transition: transform .2s var(--ease-out-quint); }
  .ms.open .ms-caret { transform: rotate(180deg); }
  .ms-panel {
    position: absolute; z-index: 5; top: calc(100% + 6px); left: 0; right: 0;
    background: var(--card); border: 1px solid var(--border-300); border-radius: 10px;
    box-shadow: var(--shadow-card-hover); overflow: hidden;
  }
  .ms-search { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--border-200); }
  .ms-search .svg { width: 15px; height: 15px; color: var(--type-footer); flex-shrink: 0; }
  .ms-search input { flex: 1; height: auto; padding: 0; border: none; background: transparent; box-shadow: none; font-size: 13px; color: var(--type-emphasized); border-radius: 0; }
  .ms-search input:focus { border: none; box-shadow: none; }
  .ms-actions { display: flex; gap: 8px; padding: 2px 2px 8px; }
  .ms-action {
    flex: 1; padding: 6px 8px; font-size: 12px; font-weight: 600; font-family: inherit;
    color: var(--type-subheader); background: var(--accent); border: 1px solid var(--border-300);
    border-radius: 6px; cursor: pointer; transition: border-color .15s var(--ease-out-quint), color .15s var(--ease-out-quint);
  }
  .ms-action:hover { border-color: var(--primary-600); color: var(--primary-400); }
  .ms-list { max-height: 210px; overflow-y: auto; padding: 6px; }
  .ms-list::-webkit-scrollbar { width: 10px; }
  .ms-list::-webkit-scrollbar-thumb { background: var(--border-300); border-radius: 6px; border: 3px solid var(--card); }
  .opt-row {
    display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 9px;
    border: none; background: transparent; border-radius: 7px; cursor: pointer;
    color: var(--type-subheader); font-size: 13.5px; font-family: inherit; text-align: left;
    transition: background-color .15s var(--ease-out-quint), color .15s var(--ease-out-quint);
  }
  .opt-row:hover { background: var(--accent); color: var(--type-emphasized); }
  .opt-name { flex: 1; }
  .opt-code { color: var(--type-footer); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .opt-check { width: 16px; display: flex; justify-content: center; color: var(--primary-500); opacity: 0; }
  .opt-row.on { color: var(--type-emphasized); }
  .opt-row.on .opt-check { opacity: 1; }
  .opt-check .svg { width: 15px; height: 15px; }
  .opt-empty { padding: 14px; text-align: center; color: var(--type-footer); font-size: 13px; }

  .check { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
  .check input { width: 16px; height: 16px; accent-color: var(--primary-600); cursor: pointer; }
  .check input:disabled { cursor: not-allowed; }
  .check span { font-size: 14px; color: var(--type-dimmed); display: inline-flex; align-items: center; gap: 8px; }
  .check input:disabled + span { opacity: .55; }
  select {
    display: block; width: 100%; height: 40px; padding: 0 36px 0 12px; font-size: 14px;
    font-family: inherit; color: var(--type-emphasized); background-color: #0c0c0c;
    border: 1px solid var(--border-300); border-radius: 8px; outline: none; cursor: pointer;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 12px center;
    transition: border-color .2s var(--ease-out-quint), box-shadow .2s var(--ease-out-quint);
  }
  select:focus { border-color: var(--primary-500); box-shadow: 0 0 0 3px var(--primary-ring); }
  select:disabled { opacity: .55; cursor: not-allowed; }
  select option { background: var(--card); color: var(--type-emphasized); }

  /* Pro features: one tinted panel instead of a badge on every row. */
  .pro {
    margin: 4px 0 22px; padding: 16px 16px 2px;
    border: 1px solid var(--border-200); border-radius: 10px; background: #0e0e0e;
    transition: border-color .25s var(--ease-out-quint), background-color .25s var(--ease-out-quint);
  }
  .pro.unlocked { border-color: var(--primary-ring); background: rgba(37,99,235,0.05); }
  .pro-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 12px; margin-bottom: 14px; }
  .pro-head h3 { white-space: nowrap; }
  .pro-head h3 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--primary-400); }
  .pro-state { font-size: 12px; color: var(--type-footer); }
  .pro-state a { color: var(--primary-500); text-decoration: none; }
  .pro-state a:hover { text-decoration: underline; }
  .pro.unlocked .pro-state { color: var(--success-500); }
  .pro .field.last { margin-bottom: 14px; }
  .btn.sync { width: auto; padding: 9px 16px; font-size: 13px; text-decoration: none; }

  /* Button (store: rounded-lg, py-2.5 px-6, font-semibold text-sm, ease-out-quint, active:scale-[0.98]).
     Hover/active effects are gated behind :not([disabled]) so a disabled button stays fully inert. */
  .btn {
    width: 100%; padding: 11px 24px; font-size: 14px; font-weight: 600; font-family: inherit;
    border: 1px solid transparent; border-radius: 8px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    transition: background-color .2s var(--ease-out-quint), border-color .2s var(--ease-out-quint), color .2s var(--ease-out-quint), transform .2s var(--ease-out-quint), opacity .2s var(--ease-out-quint);
  }
  .btn:not([disabled]):active { transform: scale(0.98); }
  .btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--primary-500); }
  .btn.primary { background: var(--primary-600); color: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.4); }
  .btn.primary:not([disabled]):hover { background: var(--primary-700); }
  .btn.ghost { background: transparent; color: var(--type-subheader); border-color: var(--border-300); }
  .btn.ghost:not([disabled]):hover { border-color: var(--primary-600); color: var(--primary-400); }
  .btn[disabled] { opacity: .45; cursor: not-allowed; }

  .row { display: flex; gap: 10px; margin-top: 10px; }
  .row .btn { flex: 1; font-size: 13px; padding: 10px; }
  .note { text-align: center; font-size: 12px; color: var(--success-500); height: 14px; margin-top: 10px; opacity: 0; transition: opacity .2s var(--ease-out-quint); }
  .note.show { opacity: 1; }
  .foot { padding-top: 13px; border-top: 1px solid var(--border-200); text-align: center; }
  .foot a { display: inline-flex; align-items: center; gap: 6px; color: var(--type-footer); font-size: 12px; text-decoration: none; transition: color .15s var(--ease-out-quint); }
  .foot a:hover { color: var(--type-dimmed); }
  .foot a .svg { width: 13px; height: 13px; }
  .svg { width: 17px; height: 17px; flex-shrink: 0; }
</style>
</head>
<body>
  <canvas id="bg"></canvas>
  <main class="card">
    <div class="brand">
      <img src="/logo.png" alt="Wyzie logo" width="36" height="36" />
      <div>
        <h1><span>Wyzie</span> Subs</h1>
        <div class="tag">for Stremio</div>
      </div>
    </div>
    <h2 class="title">Add Wyzie Subs to Stremio</h2>
    <p class="lead">Subtitles matched to the file you're playing. Pro keys add more providers (including anime), dual-language subtitles and AI translation. Set your options, then install.</p>

    <div class="field">
      <label for="apiKey">Wyzie API key</label>
      <div class="input-wrap">
        <span class="input-icon"><svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L21 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg></span>
        <input id="apiKey" class="has-icon" type="text" placeholder="wyzie-..." autocomplete="off" spellcheck="false" aria-describedby="keyStatus" />
        <span id="keyStatus" class="input-status" hidden></span>
      </div>
      <div id="keyMsg" class="hint key-msg" hidden>This key is on hold. <a href="https://store.wyzie.io/verify" target="_blank" rel="noopener">Verify your site</a> to reinstate it, or <a href="https://store.wyzie.io/contact" target="_blank" rel="noopener">contact support</a>. You can install now; subtitles resume once it is released.</div>
      <div class="hint">No key yet? <a href="https://store.wyzie.io/#plans" target="_blank" rel="noopener">Grab a free one</a> (1,000 requests/day).</div>
    </div>

    <div class="field">
      <label id="langsLabel">Preferred languages <span class="opt">(optional)</span></label>
      <div class="ms" id="ms">
        <div class="ms-control" id="msControl" role="button" tabindex="0" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="langsLabel">
          <span class="ms-chips" id="msChips"></span>
          <svg class="svg ms-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="ms-panel" id="msPanel" role="listbox" aria-multiselectable="true" hidden>
          <div class="ms-search">
            <svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input id="msSearch" type="text" placeholder="Search languages" autocomplete="off" spellcheck="false" />
          </div>
          <div class="ms-list" id="msList">
            <div class="ms-actions">
              <button type="button" class="ms-action" id="msAll">Select all</button>
              <button type="button" class="ms-action" id="msNone">Deselect all</button>
            </div>
            <div id="msRows"></div>
          </div>
        </div>
      </div>
      <div class="hint">Leave empty to fetch every available language.</div>
    </div>

    <div class="field">
      <label class="check"><input id="hi" type="checkbox" /><span>Prefer hearing-impaired (SDH) subtitles</span></label>
      <div class="hint">SDH subtitles are listed first; the others are still shown.</div>
    </div>

    <div class="field">
      <label class="check"><input id="plain" type="checkbox" /><span>Clean formatting</span></label>
      <div class="hint">Strips leftover styling tags and fixes lines that overlap or repeat.</div>
    </div>

    <section class="pro" aria-labelledby="proTitle">
      <div class="pro-head">
        <h3 id="proTitle">Pro features</h3>
        <span class="pro-state" id="proState">Needs a Pro key</span>
      </div>

      <div class="field">
        <label for="dual">Dual subtitles</label>
        <select id="dual" disabled><option value="">Off</option></select>
        <div class="hint">Shows a second language under each line. Your best subtitles get a “+ Language” copy; the originals stay listed.</div>
      </div>

      <div class="field">
        <label class="check"><input id="ai" type="checkbox" disabled /><span>AI-translate into my languages</span></label>
        <div class="hint">One AI-translated option per selected language, for titles with no native subtitle. Needs at least one language chosen above.</div>
      </div>

      <div class="field">
        <label class="check"><input id="sdh" type="checkbox" disabled /><span>Remove hearing-impaired text</span></label>
        <div class="hint">Drops cues like [door creaks] and speaker labels from every subtitle.</div>
      </div>

      <div class="field">
        <label class="check"><input id="clean" type="checkbox" disabled /><span>Mask strong profanity</span></label>
        <div class="hint">English subtitles only.</div>
      </div>

      <div class="field last">
        <label>Sync subtitles</label>
        <a class="btn ghost sync" href="https://sub.wyzie.io/synced" target="_blank" rel="noopener">
          <svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg>
          Open Wyzie Synced
        </a>
        <div class="hint">Out of sync? Wyzie Synced listens to your video in your browser and times the subtitle to the speech; drag the file it gives you onto Stremio's player. Stremio doesn't share audio with addons, so this can't run inside it.</div>
      </div>
    </section>

    <button id="install" class="btn primary">
      <svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
      Install in Stremio
    </button>
    <div class="row">
      <button id="copy" class="btn ghost">
        <svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        Copy Link
      </button>
      <button id="web" class="btn ghost">
        <svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        Stremio Web
      </button>
    </div>
    <div id="note" class="note"></div>

    <div class="foot"><a href="https://docs.wyzie.io" target="_blank" rel="noopener">Documentation and help
    </a></div>
  </main>

<script>
  var PREFILL = ${PREFILL};
  function $(id){ return document.getElementById(id); }
  var key = $('apiKey'), hi = $('hi'), plain = $('plain');
  var ai = $('ai'), sdh = $('sdh'), clean = $('clean'), dual = $('dual');
  var proEl = document.querySelector('.pro'), proState = $('proState');
  var installBtn = $('install'), webBtn = $('web'), copyBtn = $('copy'), note = $('note');
  var keyType = null; // "paid" | "free" | null, from /validate

  // [ISO 639-1 code, English name, flagcdn country code]. pb is OpenSubtitles'
  // code for Brazilian Portuguese (pt also includes it).
  var LANGS = [
    ['en','English','us'], ['es','Spanish','es'], ['fr','French','fr'], ['de','German','de'],
    ['it','Italian','it'], ['pt','Portuguese','pt'], ['pb','Portuguese (Brazil)','br'],
    ['ru','Russian','ru'], ['ja','Japanese','jp'],
    ['ko','Korean','kr'], ['zh','Chinese','cn'], ['ar','Arabic','sa'], ['hi','Hindi','in'],
    ['nl','Dutch','nl'], ['pl','Polish','pl'], ['tr','Turkish','tr'], ['sv','Swedish','se'],
    ['da','Danish','dk'], ['fi','Finnish','fi'], ['no','Norwegian','no'], ['cs','Czech','cz'],
    ['el','Greek','gr'], ['he','Hebrew','il'], ['th','Thai','th'], ['id','Indonesian','id'],
    ['vi','Vietnamese','vn'], ['ro','Romanian','ro'], ['hu','Hungarian','hu'], ['uk','Ukrainian','ua'],
    ['bg','Bulgarian','bg'], ['hr','Croatian','hr'], ['sr','Serbian','rs'], ['sk','Slovak','sk'],
    ['sl','Slovenian','si'], ['ms','Malay','my'], ['fa','Persian','ir'], ['ca','Catalan','es'],
    ['et','Estonian','ee'], ['lv','Latvian','lv'], ['lt','Lithuanian','lt'], ['af','Afrikaans','za'],
    ['sq','Albanian','al'], ['am','Amharic','et'], ['hy','Armenian','am'], ['az','Azerbaijani','az'],
    ['eu','Basque','es'], ['be','Belarusian','by'], ['bn','Bengali','bd'], ['bs','Bosnian','ba'],
    ['my','Burmese','mm'], ['km','Khmer','kh'], ['ka','Georgian','ge'], ['gl','Galician','es'],
    ['gu','Gujarati','in'], ['ha','Hausa','ng'], ['is','Icelandic','is'], ['ig','Igbo','ng'],
    ['ga','Irish','ie'], ['jv','Javanese','id'], ['kn','Kannada','in'], ['kk','Kazakh','kz'],
    ['ky','Kyrgyz','kg'], ['lo','Lao','la'], ['lb','Luxembourgish','lu'], ['mk','Macedonian','mk'],
    ['mg','Malagasy','mg'], ['ml','Malayalam','in'], ['mt','Maltese','mt'], ['mi','Maori','nz'],
    ['mr','Marathi','in'], ['mn','Mongolian','mn'], ['ne','Nepali','np'], ['ps','Pashto','af'],
    ['pa','Punjabi','in'], ['qu','Quechua','pe'], ['sm','Samoan','ws'], ['gd','Scottish Gaelic','gb-sct'],
    ['sn','Shona','zw'], ['sd','Sindhi','pk'], ['si','Sinhala','lk'], ['so','Somali','so'],
    ['st','Sesotho','ls'], ['su','Sundanese','id'], ['sw','Swahili','tz'], ['tg','Tajik','tj'],
    ['ta','Tamil','in'], ['tt','Tatar','ru'], ['te','Telugu','in'], ['ti','Tigrinya','er'],
    ['to','Tongan','to'], ['tk','Turkmen','tm'], ['ur','Urdu','pk'], ['ug','Uyghur','cn'],
    ['uz','Uzbek','uz'], ['cy','Welsh','gb-wls'], ['fy','Frisian','nl'], ['xh','Xhosa','za'],
    ['yi','Yiddish','il'], ['yo','Yoruba','ng'], ['zu','Zulu','za'], ['ny','Chichewa','mw'],
    ['co','Corsican','fr'], ['fo','Faroese','fo'], ['fj','Fijian','fj'], ['ht','Haitian Creole','ht'],
    ['ku','Kurdish','iq'], ['oc','Occitan','fr'], ['or','Odia','in'], ['rw','Kinyarwanda','rw'],
    ['sa','Sanskrit','in'], ['br','Breton','fr'], ['bo','Tibetan','cn'], ['dv','Divehi','mv'],
    ['gn','Guarani','py'], ['kl','Greenlandic','gl'], ['ln','Lingala','cd'], ['om','Oromo','et'],
    ['rm','Romansh','ch'], ['ss','Swati','sz'], ['ts','Tsonga','za'], ['tn','Tswana','bw'],
    ['ve','Venda','za'], ['wo','Wolof','sn'], ['ak','Akan','gh'], ['lg','Ganda','ug'],
    ['ki','Kikuyu','ke'], ['ay','Aymara','bo'], ['dz','Dzongkha','bt'], ['ee','Ewe','gh'],
    ['ff','Fula','sn']
  ];
  var langByCode = {};
  for (var li = 0; li < LANGS.length; li++) langByCode[LANGS[li][0]] = LANGS[li];
  (function(){
    var h = '<option value="">Off</option>';
    for (var i = 0; i < LANGS.length; i++) h += '<option value="' + LANGS[i][0] + '">' + LANGS[i][1] + '</option>';
    document.getElementById('dual').innerHTML = h;
  })();

  var msEl = $('ms'), msControl = $('msControl'), msPanel = $('msPanel');
  var msChips = $('msChips'), msList = $('msList'), msRows = $('msRows'), msSearch = $('msSearch');

  var selected = [];
  if (PREFILL.languages) {
    // A regional code the list doesn't offer (es-mx) shows as its language.
    String(PREFILL.languages).split(',').forEach(function(s){
      s = s.trim().toLowerCase();
      if (!langByCode[s]) s = s.split('-')[0];
      if (s && langByCode[s] && selected.indexOf(s) === -1) selected.push(s);
    });
  } else {
    // First-time setup: default to the visitor's browser/locale language
    // (Brazilian Portuguese is its own entry).
    var navFull = (navigator.language || navigator.userLanguage || '').toLowerCase();
    var navLang = navFull.indexOf('pt-br') === 0 ? 'pb' : navFull.slice(0, 2);
    if (navLang && langByCode[navLang]) selected = [navLang];
  }
  if (PREFILL.hi) hi.checked = true;
  if (PREFILL.plain) plain.checked = true;
  if (PREFILL.apiKey) key.value = PREFILL.apiKey;

  // Pro options only work on a Pro key (a free key's download is refused), so
  // they stay disabled until /validate confirms one. What the user asked for
  // is remembered separately, so it comes back if the key turns out to be Pro.
  var PRO_CHECKS = [ai, sdh, clean];
  var wanted = { ai: !!PREFILL.ai, sdh: !!PREFILL.sdh, clean: !!PREFILL.clean, dual: PREFILL.dual || '' };
  function updatePro(){
    var paid = keyType === 'paid';
    for (var i = 0; i < PRO_CHECKS.length; i++) {
      var c = PRO_CHECKS[i];
      c.disabled = !paid;
      c.checked = paid && wanted[c.id];
    }
    dual.disabled = !paid;
    dual.value = paid ? wanted.dual : '';
    proEl.classList.toggle('unlocked', paid);
    if (paid) proState.textContent = 'Unlocked';
    else if (keyType === 'free') proState.innerHTML = 'Free key. <a href="https://store.wyzie.io/#plans" target="_blank" rel="noopener">Upgrade to Pro</a>';
    else proState.textContent = 'Needs a Pro key';
  }
  for (var pi = 0; pi < PRO_CHECKS.length; pi++) {
    PRO_CHECKS[pi].addEventListener('change', function(e){ if (!e.target.disabled) wanted[e.target.id] = e.target.checked; });
  }
  dual.addEventListener('change', function(){ if (!dual.disabled) wanted.dual = dual.value; });

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function flag(cc){
    return '<img class="flag" src="https://flagcdn.com/24x18/' + cc + '.png" srcset="https://flagcdn.com/48x36/' + cc + '.png 2x" width="24" height="18" alt="" loading="lazy" />';
  }
  var X_SVG = '<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>';
  var CHECK_SVG = '<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  function renderChips(){
    if (!selected.length) { msChips.innerHTML = '<span class="ms-ph">All languages</span>'; return; }
    // Collapse to a count once the list gets long, to avoid a giant chip wall.
    if (selected.length > 8) {
      var label = selected.length === LANGS.length ? 'All ' + LANGS.length + ' languages' : selected.length + ' languages selected';
      msChips.innerHTML = '<span class="chip chip-count">' + label + '</span>';
      return;
    }
    var h = '';
    for (var i = 0; i < selected.length; i++) {
      var L = langByCode[selected[i]];
      if (!L) continue;
      h += '<span class="chip">' + flag(L[2]) + '<span class="chip-code">' + L[0].toUpperCase() + '</span>' +
        '<button type="button" class="chip-x" data-code="' + L[0] + '" aria-label="Remove ' + esc(L[1]) + '">' + X_SVG + '</button></span>';
    }
    msChips.innerHTML = h;
  }
  function renderList(){
    var q = (msSearch.value || '').toLowerCase().trim();
    var h = '';
    for (var i = 0; i < LANGS.length; i++) {
      var code = LANGS[i][0], name = LANGS[i][1], cc = LANGS[i][2];
      if (q && code.indexOf(q) === -1 && name.toLowerCase().indexOf(q) === -1) continue;
      var on = selected.indexOf(code) !== -1;
      h += '<button type="button" class="opt-row' + (on ? ' on' : '') + '" data-code="' + code + '" role="option" aria-selected="' + on + '">' +
        flag(cc) + '<span class="opt-name">' + esc(name) + '</span><span class="opt-code">' + code + '</span>' +
        '<span class="opt-check">' + CHECK_SVG + '</span></button>';
    }
    msRows.innerHTML = h || '<div class="opt-empty">No matching languages</div>';
  }
  function toggleLang(code){
    var k = selected.indexOf(code);
    if (k === -1) selected.push(code); else selected.splice(k, 1);
    renderChips(); renderList();
  }
  function openPanel(){ msEl.classList.add('open'); msPanel.hidden = false; msControl.setAttribute('aria-expanded', 'true'); msSearch.value = ''; renderList(); setTimeout(function(){ msSearch.focus(); }, 0); }
  function closePanel(){ msEl.classList.remove('open'); msPanel.hidden = true; msControl.setAttribute('aria-expanded', 'false'); }

  msControl.addEventListener('click', function(e){
    if (e.target.closest('.chip-x')) return;
    if (msPanel.hidden) openPanel(); else closePanel();
  });
  msControl.addEventListener('keydown', function(e){
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (msPanel.hidden) openPanel(); else closePanel(); }
  });
  msChips.addEventListener('click', function(e){
    var x = e.target.closest('.chip-x');
    if (x) { e.stopPropagation(); toggleLang(x.getAttribute('data-code')); }
  });
  msList.addEventListener('click', function(e){
    var row = e.target.closest('.opt-row');
    if (row) {
      // Keep the panel open while toggling; stop the click reaching the
      // document handler (the row node is detached on re-render, which would
      // otherwise read as an outside click and close the panel).
      e.stopPropagation();
      toggleLang(row.getAttribute('data-code'));
      msSearch.focus();
    }
  });
  msSearch.addEventListener('input', renderList);
  $('msAll').addEventListener('click', function(e){
    e.stopPropagation();
    selected = LANGS.map(function(l){ return l[0]; });
    renderChips(); renderList();
  });
  $('msNone').addEventListener('click', function(e){
    e.stopPropagation();
    selected = [];
    renderChips(); renderList();
  });
  document.addEventListener('click', function(e){ if (!msEl.contains(e.target)) closePanel(); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closePanel(); });
  renderChips();

  function buildUrls() {
    var cfg = { apiKey: key.value.trim() };
    // Selecting everything is the same as no filter, so keep the URL short.
    if (selected.length && selected.length < LANGS.length) cfg.languages = selected.join(',');
    if (hi.checked) cfg.hi = true;
    if (plain.checked) cfg.plain = true;
    if (keyType === 'paid') {
      if (ai.checked) cfg.ai = true;
      if (sdh.checked) cfg.sdh = true;
      if (clean.checked) cfg.clean = true;
      if (dual.value) cfg.dual = dual.value;
    }
    var seg = encodeURIComponent(JSON.stringify(cfg));
    var path = '/' + seg + '/manifest.json';
    var httpsUrl = 'https://' + location.host + path;
    return {
      deep: 'stremio://' + location.host + path,
      web: 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(httpsUrl),
      https: httpsUrl
    };
  }
  // API-key verification. The key is validated against Wyzie /sources (which
  // costs no quota) through the worker's own /validate proxy, so the user can
  // only continue once the key is confirmed valid.
  var keyStatusEl = $('keyStatus'), keyMsgEl = $('keyMsg');
  var keyState = 'idle'; // idle | checking | valid | held | invalid | warn
  var debounceT = null;
  var ICONS = {
    loader: '<svg class="svg spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    valid: '<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>',
    invalid: '<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    warn: '<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'
  };
  function setKeyStatus(state, msg, icon){
    keyState = state;
    keyMsgEl.hidden = state !== 'held';
    if (state === 'idle') {
      keyStatusEl.hidden = true; keyStatusEl.className = 'input-status'; keyStatusEl.innerHTML = '';
      keyStatusEl.removeAttribute('title'); keyStatusEl.removeAttribute('aria-label');
      key.classList.remove('has-status');
    } else {
      keyStatusEl.hidden = false; keyStatusEl.className = 'input-status ' + (state === 'held' ? 'warn' : state);
      keyStatusEl.innerHTML = ICONS[icon] || '';
      keyStatusEl.setAttribute('title', msg);
      keyStatusEl.setAttribute('aria-label', msg);
      key.classList.add('has-status');
    }
    refresh();
  }
  function checkKey(v){
    fetch('/validate?key=' + encodeURIComponent(v))
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (key.value.trim() !== v) return; // a newer keystroke superseded this
        // Remember the tier so the Pro-only options can enable themselves.
        keyType = (d && d.valid === true) ? (d.type === 'paid' ? 'paid' : 'free') : null;
        // "held" is optional: an older /validate (or billing API) omits it.
        if (d && d.valid === true && d.held === true) setKeyStatus('held', 'Key on hold: verify your site at store.wyzie.io/verify (or contact support)', 'warn');
        else if (d && d.valid === true) setKeyStatus('valid', 'Valid ' + (d.type === 'paid' ? 'Pro' : 'free') + ' key', 'valid');
        else if (d && d.valid === false) setKeyStatus('invalid', 'Invalid API key', 'invalid');
        else setKeyStatus('warn', 'Could not verify key, check your connection', 'warn');
        updatePro();
      })
      .catch(function(){ if (key.value.trim() === v) { keyType = null; setKeyStatus('warn', 'Could not verify key, check your connection', 'warn'); updatePro(); } });
  }
  function queueCheck(){
    var v = key.value.trim();
    clearTimeout(debounceT);
    if (!v) { keyType = null; setKeyStatus('idle'); updatePro(); return; }
    setKeyStatus('checking', 'Verifying key', 'loader');
    debounceT = setTimeout(function(){ checkKey(v); }, 450);
  }

  // A held key is a real key (it only needs its site verified), so installing
  // is allowed; the addon shows the hold in the subtitle list until released.
  function valid(){ return keyState === 'valid' || keyState === 'held'; }
  function refresh(){
    var ok = valid();
    installBtn.disabled = !ok; webBtn.disabled = !ok; copyBtn.disabled = !ok;
  }
  function toast(m){ note.textContent = m; note.classList.add('show'); setTimeout(function(){ note.classList.remove('show'); }, 2200); }

  key.addEventListener('input', queueCheck);
  refresh();
  updatePro();
  if (key.value.trim()) { setKeyStatus('checking', 'Verifying key', 'loader'); checkKey(key.value.trim()); }

  installBtn.addEventListener('click', function(){ if (valid()) window.location.href = buildUrls().deep; });
  webBtn.addEventListener('click', function(){ if (valid()) window.open(buildUrls().web, '_blank'); });
  copyBtn.addEventListener('click', function(){
    if (!valid()) return;
    var url = buildUrls().https;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function(){ toast('Install link copied'); }, function(){ toast('Copy failed'); });
    } else { toast('Copy not supported'); }
  });

  // Background particle field. Drifting primary-tinted nodes linked by faint
  // lines when close. Skipped entirely when the user prefers reduced motion.
  (function(){
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var canvas = document.getElementById('bg');
    if (!canvas || reduce) return;
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0, cssW = 0, cssH = 0, pts = [];
    function measure(){
      var rect = canvas.getBoundingClientRect();
      cssW = Math.round(rect.width) || window.innerWidth || document.documentElement.clientWidth || 0;
      cssH = Math.round(rect.height) || window.innerHeight || document.documentElement.clientHeight || 0;
    }
    function resize(){
      measure();
      W = canvas.width = Math.floor(cssW * dpr);
      H = canvas.height = Math.floor(cssH * dpr);
    }
    function seed(){
      resize();
      var count = Math.round((cssW * cssH) / 1000);
      count = Math.max(45, Math.min(110, count));
      pts = [];
      for (var i = 0; i < count; i++) {
        pts.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.28 * dpr,
          vy: (Math.random() - 0.5) * 0.28 * dpr,
          r: (Math.random() * 1.5 + 0.6) * dpr
        });
      }
    }
    function frame(){
      ctx.clearRect(0, 0, W, H);
      var maxd = 130 * dpr;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
        for (var j = i + 1; j < pts.length; j++) {
          var q = pts[j];
          var dx = p.x - q.x, dy = p.y - q.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < maxd) {
            var a = (1 - dist / maxd) * 0.16;
            ctx.strokeStyle = 'rgba(59,130,246,' + a + ')';
            ctx.lineWidth = dpr;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        }
      }
      for (var k = 0; k < pts.length; k++) {
        var d = pts[k];
        ctx.fillStyle = 'rgba(96,165,250,0.5)';
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
      }
      if (!window.__pauseParticles) requestAnimationFrame(frame);
    }
    window.addEventListener('resize', seed);
    // Kick off via setTimeout (fires even before first paint / when throttled),
    // retrying until the canvas has a measured size, then start the rAF loop.
    function boot(){
      seed();
      if (!cssW || !cssH) { setTimeout(boot, 50); return; }
      frame();
    }
    setTimeout(boot, 0);
  })();
</script>
</body>
</html>`;
}

function parseConfig(seg) {
  if (!seg) return {};
  // Stremio's SDK convention: the config is a URL-encoded JSON blob in the
  // first path segment (stremio-addon-sdk getRouter.js does JSON.parse on the
  // Express-decoded param). Fall back to base64 for hand-crafted install URLs.
  try {
    return sanitizeConfig(JSON.parse(decodeURIComponent(seg)));
  } catch {}
  try {
    return sanitizeConfig(JSON.parse(atob(seg)));
  } catch {}
  return {};
}

// The config segment is attacker-controlled (anyone can craft a link), so keep
// only the known fields, each in its expected shape:
//   apiKey     a `wyzie-` + 32 key; anything else is dropped and flagged
//              badKey so the subtitle list can say so
//   languages  comma-separated (or an array of) language codes, normalized by
//              configLang (pt-br -> pb, eng -> en; unknown ones dropped) and
//              returned as the comma-separated string the configure page uses
//   hi         a boolean (true, or the "true"/"on" a form checkbox gives)
//   ai         a boolean: offer AI-translated subtitles (Pro keys only)
//   dual       a two-letter code: also offer each subtitle with this second
//              language merged in (Pro keys only; /c/ dual=)
//   sdh        a boolean: strip hearing-impaired text (Pro keys only; sdh=strip)
//   clean      a boolean: mask strong profanity (Pro keys only; clean=1)
//   plain      a boolean: strip styling, fix overlapping lines (plain=1)
function sanitizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};

  const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  if (API_KEY_RE.test(apiKey)) out.apiKey = apiKey;
  else if (apiKey) out.badKey = true;

  const rawLangs = Array.isArray(cfg.languages)
    ? cfg.languages
    : typeof cfg.languages === 'string'
      ? cfg.languages.split(',')
      : [];
  const langs = [];
  for (const l of rawLangs) {
    if (typeof l !== 'string') continue;
    const code = configLang(l);
    if (code && !langs.includes(code)) langs.push(code);
    if (langs.length >= MAX_LANGUAGES) break;
  }
  if (langs.length) out.languages = langs.join(',');

  const on = (v) => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
  if (on(cfg.hi)) out.hi = true;
  if (on(cfg.ai)) out.ai = true;
  if (on(cfg.sdh)) out.sdh = true;
  if (on(cfg.clean)) out.clean = true;
  if (on(cfg.plain)) out.plain = true;
  const dual = typeof cfg.dual === 'string' ? cfg.dual.trim().toLowerCase() : '';
  if (/^[a-z]{2}$/.test(dual)) out.dual = dual;
  return out;
}

function parseStremioId(id) {
  // Movies:  tt1234567
  // Series:  tt1234567:1:2   (imdb : season : episode)
  const [imdb, season, episode] = id.split(':');
  return { imdb, season, episode };
}

// Stremio appends an "extras" segment before .json (e.g.
//   /subtitles/series/tt123:1:2/videoHash=abc&videoSize=456&filename=Show.S01E02.mkv.json
// ). It carries the identity of the actual video file the user is playing,
// which is what lets subtitle providers match by hash / filename instead of
// dumping every sub for the show and hoping the first one lines up. Parse it
// as URL-encoded querystring pairs: split on & first, then decode each value
// once (as the SDK's qs.parse does). Decoding the whole segment first turned
// "Tom%20%26%20Jerry" into "Tom " and dropped any value with a literal %.
function parseExtras(seg) {
  if (!seg) return {};
  return Object.fromEntries(new URLSearchParams(seg.replace(/\.json$/, '')));
}

// Ensure the subtitle file is fetched in the charset Wyzie reports for it, so
// non-Latin tracks (Arabic, Cyrillic, CJK, etc.) render correctly in Stremio
// instead of as mojibake. Wyzie's `url` already carries an `encoding` query;
// we pin it to the item's authoritative `encoding` field when provided.
function withEncoding(rawUrl, encoding) {
  if (!encoding) return rawUrl;
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('encoding', encoding);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// Release-name tokens worth boosting on — quality tier, source, codec, HDR flag,
// and audio codec. A subtitle whose release/fileName shares these with the
// user's video is far more likely to be perfectly timed for it. Case-insensitive;
// only whole-word matches count (so "10" won't spuriously match "10bit").
const RELEASE_TOKEN_RE = /\b(?:2160p|1080p|720p|480p|hdr(?:10)?|dv|dolby|imax|remux|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|web|hdtv|hdrip|dvdrip|amzn|nf|nflx|dsnp|hmax|hulu|itunes|atvp|apple|x264|x265|h264|h265|hevc|avc|10bit|8bit|aac|ac3|dts|ddp?5?\.?1|truehd|atmos)\b/gi;

function releaseTokens(text) {
  if (!text) return new Set();
  const m = String(text).toLowerCase().match(RELEASE_TOKEN_RE);
  return new Set(m || []);
}

// Extract the release-group tag from a filename ("Show.S01E02.1080p.WEB-DL.x265-GROUP.mkv" → "group").
// Groups are the strongest single signal for timing compatibility — sub authors
// almost always target one group's release when they encode timings.
function releaseGroup(text) {
  if (!text) return null;
  const m = String(text).match(/-([A-Za-z0-9]+)(?:\.[a-z0-9]{2,4})?$/i);
  return m ? m[1].toLowerCase() : null;
}

function scoreSub(sub, wantTokens, wantGroup) {
  if (!wantTokens.size && !wantGroup) return 0;
  const names = [sub.release, sub.fileName, ...(Array.isArray(sub.releases) ? sub.releases : [])].filter(Boolean);
  if (!names.length) return 0;
  let score = 0;
  for (const t of releaseTokens(names.join(' '))) if (wantTokens.has(t)) score += 1;
  // Each name's own group: joined together, only the last name's group was
  // ever seen, so most same-release subtitles went unrecognised.
  if (wantGroup && names.some((n) => releaseGroup(n) === wantGroup)) score += 5;
  return score;
}

// Base language code ("en" from "en-US"), lowercased.
function baseLang(code) {
  return String(code || '').trim().toLowerCase().split(/[-_]/)[0];
}

// mapSubs turns Wyzie /search rows into Stremio subtitle entries.
//   opts.preferHi   list hearing-impaired (SDH) subtitles first (done here, not
//                   with Wyzie's hi=true, which hard-drops every non-SDH sub).
//   opts.ai         keep the AI-translation rows (source "ai"). Off by default,
//                   so a normal picker is not flooded with ~135 machine rows.
//   opts.langs      the language codes the user configured (configLang form).
//                   AI rows are emitted only for these, one per language, the
//                   exact one (pickAiRows); with no languages set, AI rows are
//                   dropped rather than listing every language. They also pick
//                   which subtitles get a dual copy (English when unset).
//   opts.contentKey short per-title key (imdb[.season.episode]) mixed into every
//                   subtitle id. WITHOUT this, AI rows (whose Wyzie id is just
//                   "ai-<lang>") produce an identical Stremio id on every title,
//                   and Stremio serves a cached translation from a DIFFERENT
//                   show, the "wrong subtitle for the wrong show" bug. The id
//                   must be stable for one title yet unique across titles.
//   opts.options    Wyzie download options for real (/c/) links, e.g.
//                   { sdh: 'strip', clean: '1', plain: '1' }. AI rows are
//                   /translate links and never take them.
//   opts.dual       two-letter code: each of the best DUAL_MAX real subtitles
//                   in the configured languages (English when none are set),
//                   other than the second language itself, also gets a
//                   "+ <Language>" copy with dual= set, so the player shows both
//                   languages at once. The plain copies stay, so the user can
//                   still pick one language.
function mapSubs(items, filename, opts) {
  const { preferHi = false, ai = false, langs = [], contentKey = '', options = null, dual = '' } = opts || {};
  const seenUrls = new Set();
  const usedIds = new Set();
  const isAiRow = (s) => !!s && (s.ai === true || s.source === 'ai');
  // AI rows are opt-in and only for languages the user actually chose.
  const aiRows = ai && langs.length ? pickAiRows(items.filter((s) => isAiRow(s) && s.url), langs) : new Set();
  // Dual copies only for subtitles in a language the user reads: without
  // this they went to whatever came first (Hungarian, Polish, ...).
  const dualFamilies = new Set(langs.length ? langs.map(langFamily) : ['en']);
  dualFamilies.delete(langFamily(dual));
  const wantTokens = filename ? releaseTokens(filename) : new Set();
  const wantGroup = filename ? releaseGroup(filename) : null;
  const key = String(contentKey || '').replace(/[^a-z0-9]+/gi, '.');
  const scored = [];
  items.forEach((s, idx) => {
    if (!s || !s.url) return;
    const isAi = isAiRow(s);
    if (isAi && !aiRows.has(s)) return;

    const encoded = isAi ? s.url : withEncoding(s.url, s.encoding);
    if (seenUrls.has(encoded)) return; // collapse duplicate files
    seenUrls.add(encoded);
    // Options only on text files served by /c/ (an image subtitle or archive
    // with options is a 422, which would leave the row unplayable).
    const optionable = !isAi && isDownloadLink(encoded) && TEXT_FORMAT_RE.test(String(s.format || 'srt'));
    const fileUrl = optionable && options ? withParams(encoded, options) : encoded;

    // Stable, unique id per subtitle so Stremio tracks the selection correctly
    // across re-requests, and never reuses another title's cached file. The
    // per-title key guarantees uniqueness across shows; idx breaks any residual
    // tie within one response. An AI row is named by its full code, since pt
    // and pb can both be configured (pt and pt-BR rows).
    const aiCode = String(s.language || 'en').trim().toLowerCase();
    let id = 'wyzie-' + (key ? key + '-' : '') + (isAi ? 'ai-' + aiCode : (s.source || 'src') + '-' + (s.id != null ? s.id : idx));
    if (usedIds.has(id)) id += '-' + idx;
    usedIds.add(id);

    const lang = stremioLang(s.language || 'en');
    const score = isAi ? 0 : scoreSub(s, wantTokens, wantGroup);
    // Real subtitles rank above AI (a human sub beats a machine one), then SDH
    // first when preferred, then release-match score.
    const aiRank = isAi ? 1 : 0;
    const hiRank = preferHi && s.isHearingImpaired ? 0 : 1;
    const label = `${s.display || lang}${s.isHearingImpaired && !(options && options.sdh) ? ' (SDH)' : ''}`;
    scored.push({
      aiRank,
      hiRank,
      score,
      idx, // stable secondary key so equal-score subs keep provider order
      // Candidate for a bilingual copy: a real text subtitle in one of the
      // user's languages, not already in the second language.
      dualUrl: dual && optionable && dualFamilies.has(langFamily(s.language || 'en')) ? withParams(fileUrl, { dual }) : null,
      out: {
        id,
        // The Wyzie link itself. Stremio's player already routes subtitles
        // through the user's streaming server when there is one (and falls
        // back to this URL), so a hard-coded 127.0.0.1:11470 proxy only broke
        // Stremio Web on phones/TVs with a remote or no server. The link
        // carries the file's charset (withEncoding) for non-Latin scripts.
        url: fileUrl,
        lang,
        // Prefix a ✓ on top-scoring matches so the user sees which subs the
        // addon believes fit THIS release best. AI rows are labelled so the
        // user knows they are machine-translated, not a native track.
        name: isAi
          ? `${s.display || lang} · AI translated / wyzie`
          : `${score >= 5 ? '✓ ' : ''}${label} / ${s.source || 'wyzie'}`,
      },
    });
  });
  // Stable sort: real subs before AI, then SDH first when preferred, then
  // highest release-match score, ties keep provider order.
  scored.sort((a, b) => a.aiRank - b.aiRank || a.hiRank - b.hiRank || b.score - a.score || a.idx - b.idx);
  const out = scored.map((x) => x.out);
  if (!dual) return out;

  // Bilingual copies of the best-ranked subtitles, listed first: the user
  // turned this on, so Stremio's auto-pick should land on one. If Wyzie finds
  // no matching second-language file, the download is the plain subtitle.
  const second = languageName(dual);
  const dualRows = [];
  for (const x of scored) {
    if (dualRows.length >= DUAL_MAX) break;
    if (!x.dualUrl) continue;
    dualRows.push({
      id: x.out.id + '-dual-' + dual,
      url: x.dualUrl,
      lang: x.out.lang,
      name: x.out.name.replace(/ \/ ([^/]*)$/, ` + ${second} / $1`),
    });
  }
  return dualRows.concat(out);
}

const DUAL_MAX = 8;
const TEXT_FORMAT_RE = /^(srt|vtt|webvtt|ass|ssa|sub|ttml|dfxp|txt)$/i;

// A Wyzie /c/ download link (the only kind that takes download options).
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

// OpenSubtitles' regional codes as BCP 47 tags, which Intl can name.
const OS_REGIONAL_TAG = { pb: 'pt-BR', zt: 'zh-Hant', ea: 'es-419' };

// "Spanish" for "es"; the code in capitals if the runtime has no names.
function languageName(code) {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(OS_REGIONAL_TAG[code] || code);
    if (name && name.toLowerCase() !== code) return name;
  } catch {}
  return String(code).toUpperCase();
}

// Surface a status/error to the user inside Stremio's subtitle picker. Stremio
// shows a subtitle entry's `lang`, so the message goes there; the url points at
// /notice.srt, which streams a one-cue SRT of the same text, so selecting the
// row also shows the message on screen instead of failing silently.
function notice(origin, key, text) {
  return [
    {
      id: 'wyzie-notice-' + key,
      url: origin + '/notice.srt?m=' + encodeURIComponent(text),
      lang: text,
      name: text,
    },
  ];
}

// "HH:MM UTC" for a reset_at Unix timestamp (seconds), else midnight UTC.
function resetText(resetAt) {
  const t = Number(resetAt);
  if (!Number.isFinite(t) || t <= 0) return 'midnight UTC';
  return new Date(t * 1000).toISOString().slice(11, 16) + ' UTC';
}

function bareLink(url, fallback) {
  return String(url || fallback).replace(/^https?:\/\//, '');
}

// What to tell the user about a refused /search. A 403 means different things,
// so the body decides: a held key carries `reinstate` / "Key on hold", a
// Pro-only source says "free plan", and only "Invalid API key" is a bad key.
function refusalNotice(status, body) {
  const message = String(body?.message ?? '');
  const low = message.toLowerCase();
  if (status === 403) {
    if (body?.reinstate || low.includes('key on hold')) {
      return { key: 'held', text: 'Wyzie: key on hold. Verify your site at store.wyzie.io/verify (or contact support).' };
    }
    if (low.includes('free plan')) {
      return { key: 'pro', text: 'Wyzie: the chosen sources need a Pro key. Free keys get OpenSubtitles.' };
    }
    if (low.includes('invalid api key')) {
      return { key: 's403', text: 'Wyzie: invalid API key. Re-check it in the addon settings.' };
    }
    return { key: 's403', text: 'Wyzie: request refused (' + (message || '403') + ').' };
  }
  if (status === 401) {
    return { key: 's401', text: 'Wyzie: no API key sent. Check the addon settings.' };
  }
  if (status === 402) {
    return { key: 's402', text: 'Wyzie: Pro balance used up. Top up at ' + bareLink(body?.topup, 'store.wyzie.io/topup') };
  }
  if (status === 429) {
    return {
      key: 's429',
      text: 'Wyzie: daily limit reached, resets at ' + resetText(body?.reset_at) + '. Upgrade at ' + bareLink(body?.upgrade, 'store.wyzie.io/#plans'),
    };
  }
  if (status === 503) {
    return { key: 's503', text: 'Wyzie: service briefly unavailable. Try again in a moment.' };
  }
  if (status === 400) {
    // A request Wyzie can't take (e.g. "Invalid language format"): its own
    // words say what to fix, a bare "service error 400" doesn't.
    return { key: 's400', text: 'Wyzie: request rejected (' + (message || '400') + '). Check the addon settings.' };
  }
  return { key: 's' + status, text: 'Wyzie: service error ' + status + '. Try again later.' };
}

async function fetchSubtitles(type, id, extras, config, origin) {
  const { apiKey, languages, hi, ai, dual, sdh, clean, plain, badKey } = config;
  if (badKey) {
    return { subtitles: notice(origin, 's403', 'Wyzie: invalid API key. Re-check it in the addon settings.'), cacheMaxAge: 60 };
  }
  if (!apiKey) {
    return { subtitles: notice(origin, 'nokey', 'Wyzie: no API key set. Open the addon settings to add one.'), cacheMaxAge: 60 };
  }

  const { imdb, season, episode } = parseStremioId(id);
  if (!imdb?.startsWith('tt')) return { subtitles: [] };

  // For series we MUST have both season and episode, or wyzie's /search
  // returns "Both season and episode are required" (400) and Stremio shows
  // nothing. This is defensive: Stremio always sends `tt:s:e` for episodes,
  // but if we ever get called with a bare series id we degrade gracefully.
  if (type === 'series' && (!season || !episode)) {
    return { subtitles: notice(origin, 'noep', 'Wyzie: could not identify the episode. Restart the stream and try again.'), cacheMaxAge: 60 };
  }

  const url = new URL('/search', WYZIE_BASE);
  url.searchParams.set('id', imdb);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('format', 'srt');
  // Query every enabled source the key can reach for the widest coverage.
  url.searchParams.set('source', 'all');
  if (type === 'series') {
    url.searchParams.set('season', season);
    url.searchParams.set('episode', episode);
  }
  // The configured codes, as the two-letter codes the API takes (es-mx -> es).
  const langs = String(languages || '').split(',').filter(Boolean);
  const apiLangs = [...new Set(langs.map(apiLang).filter(Boolean))];
  if (apiLangs.length) url.searchParams.set('language', apiLangs.join(','));
  // No `hi` parameter: on Wyzie it is a hard filter (only SDH subtitles come
  // back). The "prefer hearing-impaired" option sorts SDH first in mapSubs.
  // NOTE on extras: Stremio sends { videoHash, videoSize, filename } when it
  // knows them. We do NOT forward filename to /search — wyzie treats it as a
  // hard filter (subs that don't literally mention that filename are DROPPED),
  // which for the common case produces zero results and looks broken. Instead
  // we use it below to re-rank the raw result set so the release that matches
  // the file the user is playing floats to the top of the picker.

  try {
    // Cap the wait so a slow/stuck upstream returns a friendly notice instead
    // of hanging until Stremio itself gives up (which shows an empty list).
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'wyzie-stremio/1.4.1' },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      // Wyzie answers 400 "No subtitles found" rather than an empty list. That
      // is a working key with no matches, not a service error.
      if (res.status === 400 && /no subtitles found/i.test(String(body?.message ?? ''))) {
        return { subtitles: notice(origin, 'empty', 'Wyzie: no subtitles found for this title.'), cacheMaxAge: 600 };
      }
      // Tell the user what happened instead of showing an empty list.
      const r = refusalNotice(res.status, body);
      return { subtitles: notice(origin, r.key, r.text), cacheMaxAge: 60 };
    }

    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.subtitles ?? []);
    const contentKey = [imdb, season, episode].filter(Boolean).join('.');
    const options = {};
    if (sdh) options.sdh = 'strip';
    if (clean) options.clean = '1';
    if (plain) options.plain = '1';
    const subs = mapSubs(list, extras?.filename, {
      preferHi: !!hi,
      ai: !!ai,
      langs,
      contentKey,
      options: Object.keys(options).length ? options : null,
      dual: dual || '',
    });
    if (!subs.length) {
      // Key works, but nothing matched this title. Say so rather than looking broken.
      return { subtitles: notice(origin, 'empty', 'Wyzie: no subtitles found for this title.'), cacheMaxAge: 600 };
    }
    return {
      subtitles: subs,
      cacheMaxAge: 3600,
      staleRevalidate: 21600,
      staleError: 86400,
    };
  } catch {
    return { subtitles: notice(origin, 'neterr', 'Wyzie: could not reach the subtitle service. Try again later.'), cacheMaxAge: 30 };
  }
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const reqUrl = new URL(request.url);
    const { pathname } = reqUrl;
    const parts = pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';

    // Served first-party: the manifest logo, the favicon and the config page
    // header all point here.
    if (pathname === '/logo.png') {
      return new Response(LOGO_PNG, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' },
      });
    }

    // Notice subtitle: a one-cue SRT carrying a status/error message, shown on
    // screen if the user selects a Wyzie notice row in the subtitle picker.
    if (pathname === '/notice.srt') {
      const m = (reqUrl.searchParams.get('m') || 'Wyzie Subs').replace(/[\r\n]+/g, ' ').slice(0, 300);
      const body = '1\n00:00:00,000 --> 00:00:30,000\n' + m + '\n';
      return new Response(body, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      });
    }

    // API-key validation proxy for the config page. Hits the billing API's
    // read-only /api/usage-limit endpoint (no quota cost, authoritative for
    // key existence + tier) and returns just { valid, type, held }. Same-origin,
    // so the page can call it without any CORS dance. `held` is true when the
    // key is on hold (the billing API's `held` flag; absent on older API
    // versions, which reads as not held).
    //
    // Why not sub.wyzie.io/sources: that endpoint is a scraping worker that
    // fans out to /api/usage-limit itself, and its `verification_unavailable`
    // fallback (a real, occasional edge condition on same-zone worker fetches)
    // was showing up in the config UI as "Could not verify the key" even for
    // valid Pro keys. Going straight to api.wyzie.io removes that hop.
    if (pathname === '/validate') {
      const k = (new URL(request.url).searchParams.get('key') || '').trim();
      if (!k) return json({ valid: false });
      // Cheap client-side format check so we can answer "invalid" without a
      // round-trip when the key can't possibly exist.
      if (!API_KEY_RE.test(k)) return json({ valid: false, type: null });
      try {
        const r = await fetch(WYZIE_API + '/api/usage-limit?api_key=' + encodeURIComponent(k), {
          headers: { 'User-Agent': 'wyzie-stremio/1.4.1', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (r.status === 404 || r.status === 403) return json({ valid: false, type: null });
        if (!r.ok) return json({ valid: null, type: null });
        const d = await r.json().catch(() => ({}));
        const type = d.key_type === 'paid' ? 'paid' : 'free';
        return json({ valid: true, type, held: d.held === true });
      } catch {
        return json({ valid: null, type: null });
      }
    }

    // Config / install UI:  /  ·  /configure  ·  /<config>/configure
    if (pathname === '/' || last === 'configure') {
      const prefill = last === 'configure' && parts.length > 1 ? parseConfig(parts[0]) : {};
      return html(configPage(prefill));
    }

    // manifest.json. The BARE manifest keeps `configurationRequired` so Stremio
    // routes the user through the config page first. A CONFIGURED manifest
    // (/<config>/manifest.json) drops it so Stremio shows "Install" directly,
    // while keeping `configurable` so users can re-open the options later.
    if (last === 'manifest.json') {
      if (parts.length > 1) {
        return json({ ...MANIFEST, behaviorHints: { configurable: true } });
      }
      return json(MANIFEST);
    }

    // subtitles: /<config?>/subtitles/<type>/<id>(.json)(/<extras>.json)?
    // Stremio appends an extras segment (videoHash, videoSize, filename)
    // when it knows them; `filename` ranks the results so the top pick lines
    // up with the exact file the user is playing.
    const subIdx = parts.indexOf('subtitles');
    if (subIdx !== -1 && parts.length >= subIdx + 3) {
      const configSeg = subIdx >= 1 ? parts[0] : '';
      const type = parts[subIdx + 1];
      // The id segment carries `.json` only when there is no trailing extras
      // segment; strip it defensively in both cases.
      const id = decodeURIComponent(parts[subIdx + 2].replace(/\.json$/, ''));
      const extras = parts.length >= subIdx + 4 ? parseExtras(parts[subIdx + 3]) : {};
      const config = parseConfig(configSeg);
      const result = await fetchSubtitles(type, id, extras, config, reqUrl.origin);
      return json(result);
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
