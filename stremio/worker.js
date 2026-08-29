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

const WYZIE_BASE = 'https://sub.wyzie.io';
const WYZIE_API = 'https://api.wyzie.io';

// Every issued Wyzie key is `wyzie-` + 32 lowercase-alphanumeric chars. Rejecting
// anything else up front lets the config page tell the user the key is malformed
// without any network round-trip.
const API_KEY_RE = /^wyzie-[a-z0-9]{32}$/i;

const MANIFEST = {
  id: 'io.wyzie.subs',
  version: '1.2.0',
  name: 'Wyzie Subs',
  description:
    'Free subtitles in 125 languages from Wyzie Subs. Aggregates OpenSubtitles, SubDL, Podnapisi and more. Get a free key at store.wyzie.io/#plans.',
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
      title: 'Prefer hearing-impaired subtitles',
      required: false,
    },
  ],
};

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
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// Standalone configure / install page. `prefill` pre-populates the form when a
// user re-opens config from an already-installed addon. The inline script uses
// string concatenation (no template literals) so it can be embedded safely.
function configPage(prefill) {
  const PREFILL = JSON.stringify(prefill || {});
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0b0b0b" />
<title>Wyzie Subs for Stremio</title>
<meta name="description" content="Install Wyzie Subs in Stremio. Free subtitles in 125 languages." />
<link rel="icon" href="https://i.postimg.cc/L5ppKYC5/cclogo.png" />
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
  .check span { font-size: 14px; color: var(--type-dimmed); }

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
      <img src="https://i.postimg.cc/L5ppKYC5/cclogo.png" alt="Wyzie logo" />
      <div>
        <h1><span>Wyzie</span> Subs</h1>
        <div class="tag">for Stremio</div>
      </div>
    </div>
    <h2 class="title">Add Wyzie Subs to Stremio</h2>
    <p class="lead">Free subtitles in 125 languages, aggregated from OpenSubtitles, SubDL, Podnapisi and more. Set your options below, then install.</p>

    <div class="field">
      <label for="apiKey">Wyzie API key</label>
      <div class="input-wrap">
        <span class="input-icon"><svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L21 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg></span>
        <input id="apiKey" class="has-icon" type="text" placeholder="wyzie-..." autocomplete="off" spellcheck="false" aria-describedby="keyStatus" />
        <span id="keyStatus" class="input-status" hidden></span>
      </div>
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
    </div>

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
  var key = $('apiKey'), hi = $('hi');
  var installBtn = $('install'), webBtn = $('web'), copyBtn = $('copy'), note = $('note');

  // [ISO 639-1 code, English name, flagcdn country code]
  var LANGS = [
    ['en','English','us'], ['es','Spanish','es'], ['fr','French','fr'], ['de','German','de'],
    ['it','Italian','it'], ['pt','Portuguese','pt'], ['ru','Russian','ru'], ['ja','Japanese','jp'],
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

  var msEl = $('ms'), msControl = $('msControl'), msPanel = $('msPanel');
  var msChips = $('msChips'), msList = $('msList'), msRows = $('msRows'), msSearch = $('msSearch');

  var selected = [];
  if (PREFILL.languages) {
    selected = String(PREFILL.languages)
      .split(',')
      .map(function(s){ return s.trim().toLowerCase(); })
      .filter(function(s){ return s && langByCode[s]; });
  } else {
    // First-time setup: default to the visitor's browser/locale language.
    var navLang = (navigator.language || navigator.userLanguage || '').slice(0, 2).toLowerCase();
    if (navLang && langByCode[navLang]) selected = [navLang];
  }
  if (PREFILL.hi) hi.checked = true;
  if (PREFILL.apiKey) key.value = PREFILL.apiKey;

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
  var keyStatusEl = $('keyStatus');
  var keyState = 'idle'; // idle | checking | valid | invalid | warn
  var debounceT = null;
  var ICONS = {
    loader: '<svg class="svg spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    valid: '<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>',
    invalid: '<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    warn: '<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'
  };
  function setKeyStatus(state, msg, icon){
    keyState = state;
    if (state === 'idle') {
      keyStatusEl.hidden = true; keyStatusEl.className = 'input-status'; keyStatusEl.innerHTML = '';
      keyStatusEl.removeAttribute('title'); keyStatusEl.removeAttribute('aria-label');
      key.classList.remove('has-status');
    } else {
      keyStatusEl.hidden = false; keyStatusEl.className = 'input-status ' + state;
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
        if (d && d.valid === true) setKeyStatus('valid', 'Valid ' + (d.type === 'paid' ? 'Pro' : 'free') + ' key', 'valid');
        else if (d && d.valid === false) setKeyStatus('invalid', 'Invalid API key', 'invalid');
        else setKeyStatus('warn', 'Could not verify key, check your connection', 'warn');
      })
      .catch(function(){ if (key.value.trim() === v) setKeyStatus('warn', 'Could not verify key, check your connection', 'warn'); });
  }
  function queueCheck(){
    var v = key.value.trim();
    clearTimeout(debounceT);
    if (!v) { setKeyStatus('idle'); return; }
    setKeyStatus('checking', 'Verifying key', 'loader');
    debounceT = setTimeout(function(){ checkKey(v); }, 450);
  }

  function valid(){ return keyState === 'valid'; }
  function refresh(){
    var ok = valid();
    installBtn.disabled = !ok; webBtn.disabled = !ok; copyBtn.disabled = !ok;
  }
  function toast(m){ note.textContent = m; note.classList.add('show'); setTimeout(function(){ note.classList.remove('show'); }, 2200); }

  key.addEventListener('input', queueCheck);
  refresh();
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
    return JSON.parse(decodeURIComponent(seg));
  } catch {}
  try {
    return JSON.parse(atob(seg));
  } catch {}
  return {};
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
// as URL-encoded querystring pairs.
function parseExtras(seg) {
  if (!seg) return {};
  const s = decodeURIComponent(seg.replace(/\.json$/, ''));
  const out = {};
  for (const pair of s.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    try {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    } catch {}
  }
  return out;
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

// Stremio's local streaming server. Routing each subtitle through it
// (subtitles.vtt?from=<file>) makes Stremio fetch the file locally, detect its
// encoding, convert it to a clean WebVTT, and serve it with proper headers.
// That fixes two classes of bug: garbled/mis-encoded text, and subtitles that
// freeze or stop updating when seeking (the player gets a fully-buffered local
// VTT instead of loading a remote SRT flakily). See stremio-addon-sdk docs.
const STREMIO_SUB_PROXY = 'http://127.0.0.1:11470/subtitles.vtt?from=';

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
  const candidates = [sub.release, sub.fileName, ...(Array.isArray(sub.releases) ? sub.releases : [])]
    .filter(Boolean)
    .join(' ');
  if (!candidates) return 0;
  let score = 0;
  const subTokens = releaseTokens(candidates);
  for (const t of subTokens) if (wantTokens.has(t)) score += 1;
  const subGroup = releaseGroup(candidates);
  if (wantGroup && subGroup && subGroup === wantGroup) score += 5;
  return score;
}

function mapSubs(items, filename) {
  const seenUrls = new Set();
  const usedIds = new Set();
  const wantTokens = filename ? releaseTokens(filename) : new Set();
  const wantGroup = filename ? releaseGroup(filename) : null;
  const scored = [];
  items.forEach((s, idx) => {
    if (!s || !s.url) return;
    const fileUrl = withEncoding(s.url, s.encoding);
    if (seenUrls.has(fileUrl)) return; // collapse duplicate files
    seenUrls.add(fileUrl);
    // Stable, unique id per subtitle so Stremio tracks the selection correctly
    // across re-requests (duplicate ids make tracks vanish or swap on seek).
    let id = 'wyzie-' + (s.source || 'src') + '-' + (s.id != null ? s.id : idx);
    if (usedIds.has(id)) id += '-' + idx;
    usedIds.add(id);
    const lang = s.language || 'en';
    const score = scoreSub(s, wantTokens, wantGroup);
    scored.push({
      score,
      idx, // stable secondary key so equal-score subs keep provider order
      out: {
        id,
        url: STREMIO_SUB_PROXY + encodeURIComponent(fileUrl),
        lang,
        // Prefix a ✓ on top-scoring matches so the user sees which subs the
        // addon believes fit THIS release best. Cheap visual, no lang change.
        name: `${score >= 5 ? '✓ ' : ''}${s.display || lang}${s.ai ? ' (AI)' : ''} / ${s.source || 'wyzie'}`,
      },
    });
  });
  // Stable sort: highest score first, ties preserve provider order.
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((x) => x.out);
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

async function fetchSubtitles(type, id, extras, config, origin) {
  const { apiKey, languages, hi } = config;
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
  if (languages) url.searchParams.set('language', languages);
  if (hi) url.searchParams.set('hi', 'true');
  // NOTE on extras: Stremio sends { videoHash, videoSize, filename } when it
  // knows them. We do NOT forward filename to /search — wyzie treats it as a
  // hard filter (subs that don't literally mention that filename are DROPPED),
  // which for the common case produces zero results and looks broken. Instead
  // we use it below to re-rank the raw result set so the release that matches
  // the file the user is playing floats to the top of the picker.

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'wyzie-stremio/1.2' },
    });

    if (!res.ok) {
      // Tell the user what happened instead of showing an empty list.
      const MESSAGES = {
        401: 'Wyzie: API key missing or unauthorized. Check the addon settings.',
        403: 'Wyzie: invalid API key. Re-check it in the addon settings.',
        402: 'Wyzie: out of requests. Top up at store.wyzie.io',
        429: 'Wyzie: daily limit reached. Resets at UTC midnight, or upgrade for more.',
      };
      const msg = MESSAGES[res.status] || ('Wyzie: service error ' + res.status + '. Try again later.');
      return { subtitles: notice(origin, 's' + res.status, msg), cacheMaxAge: 60 };
    }

    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.subtitles ?? []);
    const subs = mapSubs(list, extras?.filename);
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
    // key existence + tier) and returns just { valid, type }. Same-origin, so
    // the page can call it without any CORS dance.
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
          headers: { 'User-Agent': 'wyzie-stremio/1.2', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (r.status === 404 || r.status === 403) return json({ valid: false, type: null });
        if (!r.ok) return json({ valid: null, type: null });
        const d = await r.json().catch(() => ({}));
        const type = d.key_type === 'paid' ? 'paid' : 'free';
        return json({ valid: true, type });
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
    // when it knows them — we forward `filename` to wyzie/search so the top
    // pick lines up with the exact file the user is playing.
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
