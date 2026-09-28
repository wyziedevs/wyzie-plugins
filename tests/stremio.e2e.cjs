#!/usr/bin/env node
/**
 * End-to-end test for the Stremio addon WITHOUT installing Stremio.
 *
 * Boots the real addon over HTTP (exactly what serveHTTP does in production)
 * and hits the same endpoints the Stremio app calls:
 *   GET /manifest.json
 *   GET /<config>/subtitles/movie/<imdb>.json
 *   GET /<config>/subtitles/series/<imdb:s:e>.json
 *
 * Config is passed the way Stremio passes it: a URL-encoded JSON blob as the
 * first path segment (see stremio-addon-sdk getRouter.js).
 *
 * Run from the repo root:
 *   WYZIE_KEY=wyzie-xxxx node tests/stremio.e2e.cjs
 *   (PowerShell)  $env:WYZIE_KEY="wyzie-..."; node tests/stremio.e2e.cjs
 *
 * To eyeball it in a REAL client afterwards, keep the server up:
 *   WYZIE_KEY=... KEEP_ALIVE=1 node tests/stremio.e2e.cjs
 * then open https://web.stremio.com → Add-ons → paste the printed manifest URL.
 */
const path = require('path');
const stremioDir = path.join(__dirname, '..', 'stremio');
const { serveHTTP } = require(
  path.join(stremioDir, 'node_modules', 'stremio-addon-sdk'),
);
const addonInterface = require(path.join(stremioDir, 'addon.js'));

const KEY = process.env.WYZIE_KEY;
const PORT = Number(process.env.PORT || 7799);
const MOVIE = 'tt0816692'; // Interstellar
const SERIES = 'tt0944947:1:1'; // Game of Thrones S1E1

let pass = 0,
  fail = 0;
const ok = (n, c, d = '') => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`);
  }
};

const cfgSeg = (cfg) => encodeURIComponent(JSON.stringify(cfg));

// The addon runs in this process, so its /search calls can be answered from
// canned rows (set `stub`) for exact checks; everything else goes through.
const realFetch = globalThis.fetch;
let stub = null;
const searches = [];
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (url.startsWith('https://sub.wyzie.io/search')) {
    searches.push(new URL(url));
    if (stub) return stub(new URL(url));
  }
  return realFetch(input, init);
};
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const C = (id, language) => ({
  id: String(id), language, display: language, format: 'srt', source: 'charlie',
  url: `https://sub.wyzie.io/c/abc/id/${id}?format=srt&id=tt0816692&tok=t`,
});
const AI = (language, display) => ({
  id: 'ai-' + language, language, display, format: 'srt', source: 'ai', ai: true,
  url: `https://sub.wyzie.io/translate?id=tt0816692&tk=t&target=${encodeURIComponent(display)}`,
});
const target = (s) => decodeURIComponent(new URL(s.url).searchParams.get('target'));

// Same behaviour as worker.js (tests/worker.test.mjs checks that one).
async function offline(root) {
  const get = async (cfg, id, type = 'movie') =>
    ((await (await fetch(`${root}/${cfgSeg(cfg)}/subtitles/${type}/${id}.json`)).json()).subtitles || []);
  const key = 'wyzie-' + 'a'.repeat(32);
  const rows = [C(1, 'hu'), C(2, 'pl'), C(3, 'en'), C(4, 'pb'), C(5, 'es'),
    AI('en-AU', 'English (Australia)'), AI('en', 'English'), AI('es-AR', 'Spanish (Argentina)'), AI('es', 'Spanish'),
    AI('pt-BR', 'Portuguese (Brazil)'), AI('pt', 'Portuguese')];
  stub = () => reply(200, rows);

  console.log('\nOffline (canned /search) — parity with worker.js:');
  searches.length = 0;
  let subs = await get({ apiKey: key, languages: 'EN,pt-BR,eng,es-MX,klingon', ai: true }, 'tt0816692');
  ok('languages normalized for the API (en,pb,es)', searches[0] && searches[0].searchParams.get('language') === 'en,pb,es',
    searches[0] && searches[0].searchParams.get('language'));
  const ai = subs.filter((s) => s.id.includes('-ai-')).map(target).sort();
  ok('AI rows are the exact languages (English, Portuguese (Brazil), es-MX -> Spanish)',
    ai.join('|') === 'English|Portuguese (Brazil)|Spanish', ai.join('|'));
  ok('pb row -> pob', (subs.find((s) => s.id.endsWith('charlie-4')) || {}).lang === 'pob');
  ok('urls are direct Wyzie links', subs.every((s) => s.url.startsWith('https://sub.wyzie.io/')));
  subs = await get({ apiKey: key, dual: 'es' }, 'tt0816692');
  const duals = subs.filter((s) => s.id.includes('-dual-'));
  ok('no languages + dual: only English rows get a copy', duals.length === 1 && duals[0].lang === 'eng', duals.map((s) => s.id).join());
  stub = () => reply(400, { message: 'Invalid language format' });
  subs = await get({ apiKey: key, languages: 'en' }, 'tt0816692');
  ok('a 400 is a notice with the API message', subs.length === 1 && /Invalid language format/.test(subs[0].lang), subs[0] && subs[0].lang);
  ok('notice url is an SRT, not a store page', subs[0] && /\/notice\.srt\?m=/.test(subs[0].url));
  stub = () => reply(400, { message: 'No subtitles found' });
  subs = await get({ apiKey: key }, 'tt0816692');
  ok('400 No subtitles found -> notice', subs.length === 1 && subs[0].id === 'wyzie-notice-empty');
  stub = () => { throw new TypeError('fetch failed'); };
  subs = await get({ apiKey: key }, 'tt0816692');
  ok('network error -> notice', subs.length === 1 && subs[0].id === 'wyzie-notice-neterr');
  searches.length = 0;
  subs = await get({ apiKey: key }, 'tt0944947', 'series');
  ok('series id without season/episode -> notice, not a movie search', subs[0] && subs[0].id === 'wyzie-notice-noep' && !searches.length);
  subs = await get({ apiKey: 'not-a-key' }, 'tt0816692');
  ok('malformed key -> invalid key notice', subs[0] && /invalid API key/.test(subs[0].lang));
  stub = null;
}

async function main() {
  if (!KEY) {
    console.error('set WYZIE_KEY');
    process.exit(2);
  }

  const { url, server } = await serveHTTP(addonInterface, { port: PORT });
  const root = url.replace(/\/manifest\.json$/, '');
  const cfg = cfgSeg({ apiKey: KEY });
  console.log(`Addon up at ${root}\n`);

  try {
    console.log('Manifest:');
    {
      const r = await fetch(`${root}/manifest.json`);
      const m = await r.json();
      ok('HTTP 200', r.status === 200, `got ${r.status}`);
      ok('id is io.wyzie.subs', m.id === 'io.wyzie.subs', m.id);
      ok(
        'declares subtitles resource',
        (m.resources || []).includes('subtitles'),
      );
      ok(
        'is configurable',
        !!(m.behaviorHints && m.behaviorHints.configurable),
      );
      ok('version 1.4.1', m.version === '1.4.1', m.version);
    }

    await offline(root);

    console.log('\nSubtitles — movie:');
    {
      const r = await fetch(`${root}/${cfg}/subtitles/movie/${MOVIE}.json`);
      const data = await r.json();
      const subs = data.subtitles || [];
      ok('HTTP 200', r.status === 200, `got ${r.status}`);
      ok('returns subtitles', subs.length >= 1, `got ${subs.length}`);
      ok(
        'each has id/url/lang (Stremio shape)',
        subs.length > 0 && subs.every((s) => s.id && s.url && s.lang),
        JSON.stringify(subs[0] || {}),
      );
      ok(
        'no upsell placeholder leaked in',
        !subs.some((s) => s.id === 'wyzie-upsell'),
      );
    }

    console.log('\nSubtitles — series (hand-typed codes eng, pt-BR):');
    {
      const r = await fetch(`${root}/${cfgSeg({ apiKey: KEY, languages: 'eng,pt-BR' })}/subtitles/series/${SERIES}.json`);
      const data = await r.json();
      const subs = data.subtitles || [];
      ok('HTTP 200', r.status === 200, `got ${r.status}`);
      ok('returns subtitles, no notice', subs.length >= 1 && !subs.some((s) => s.id.startsWith('wyzie-notice')),
        subs[0] && subs[0].lang);
      ok('English rows as eng', subs.some((s) => s.lang === 'eng'));
    }

    console.log('\nPro options — dual + SDH removal + release match:');
    {
      const pro = cfgSeg({ apiKey: KEY, languages: 'en', dual: 'es', sdh: true, plain: true });
      // A release OpenSubtitles has for this episode (group "visionx").
      const file = 'Breaking.Bad.S01E01.720p.BRRip.x264-VisionX.mkv';
      // Stremio's extras segment: key=value pairs, only the values encoded.
      const extra = `filename=${encodeURIComponent(file)}`;
      const r = await fetch(`${root}/${pro}/subtitles/series/tt0903747:1:1/${extra}.json`);
      const subs = (await r.json()).subtitles || [];
      const duals = subs.filter((s) => s.id.includes('-dual-es'));
      ok('dual copies present (1..8)', duals.length >= 1 && duals.length <= 8, `got ${duals.length}`);
      ok('dual copies listed first', subs.slice(0, duals.length).every((s) => s.id.includes('-dual-')));
      ok('dual link has dual=es', duals.every((s) => /[?&]dual=es\b/.test(s.url)));
      ok('dual copies are of English rows', duals.every((s) => s.lang === 'eng'));
      ok(
        'options on every /c/ link',
        subs.filter((s) => s.url.includes('/c/')).every((s) => /sdh=strip/.test(s.url) && /plain=1/.test(s.url)),
      );
      ok('ids unique + title-scoped', new Set(subs.map((s) => s.id)).size === subs.length
        && subs.every((s) => s.id.includes('tt0903747')));
      const firstPlain = subs[duals.length];
      ok('best release match ranked first (✓)', !!firstPlain && firstPlain.name.startsWith('✓ '), firstPlain && firstPlain.name);
      if (duals[0]) {
        const d = await fetch(duals[0].url);
        ok('dual download merges Spanish (X-Dual: es)', d.ok && d.headers.get('x-dual') === 'es', `${d.status} ${d.headers.get('x-dual')}`);
      }
    }

    console.log('\nNo-config request (no apiKey):');
    {
      const r = await fetch(`${root}/subtitles/movie/${MOVIE}.json`);
      const data = await r.json();
      const subs = data.subtitles || [];
      ok(
        'HTTP 200 and one "no API key" notice',
        r.status === 200 && subs.length === 1 && subs[0].id === 'wyzie-notice-nokey',
        `status ${r.status}, ${subs.length} subs`,
      );
    }
  } finally {
    console.log(`\n${'='.repeat(40)}\n${pass} passed, ${fail} failed`);
    if (process.env.KEEP_ALIVE) {
      console.log(`\nKEEP_ALIVE set — server still running.`);
      console.log(`Install URL for web.stremio.com:`);
      console.log(`  ${root}/${cfg}/manifest.json`);
      console.log(`(Ctrl+C to stop)`);
    } else {
      server.close();
      process.exit(fail ? 1 : 0);
    }
  }
}

main().catch((e) => {
  console.error('crashed:', e);
  process.exit(3);
});
