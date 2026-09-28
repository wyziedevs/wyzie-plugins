#!/usr/bin/env node
/**
 * Tests for the PRODUCTION Stremio addon, stremio/worker.js (the Cloudflare
 * Worker behind stremio.wyzie.io), without wrangler or Stremio.
 *
 * worker.js is an ES module whose default export is `{ fetch(request) }`. This
 * imports it in Node and calls fetch() with Request objects, the way the
 * Workers runtime does. Two kinds of checks:
 *
 *   offline  /search is answered from canned rows (global fetch is wrapped),
 *            so language normalization, AI row choice, dual copies, extras
 *            parsing and notices are checked exactly. No key needed.
 *   live     a few requests against the real API (needs WYZIE_KEY, a Pro key
 *            for the AI check). About 4 /search calls.
 *
 * Run from the repo root (Node 22.15+, for module.registerHooks):
 *   WYZIE_KEY=wyzie-xxxx node tests/worker.test.mjs
 *   (PowerShell)  $env:WYZIE_KEY="wyzie-..."; node tests/worker.test.mjs
 */
import { registerHooks } from 'node:module';

// worker.js imports ./logo.png (wrangler bundles it as an ArrayBuffer). Node
// can't load a .png, so hand it a stand-in, and load worker.js as ESM even
// though stremio/package.json has no "type": "module".
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.png')) {
      return { format: 'module', source: 'export default new ArrayBuffer(8);', shortCircuit: true };
    }
    if (url.endsWith('/stremio/worker.js')) return nextLoad(url, { ...context, format: 'module' });
    return nextLoad(url, context);
  },
});

const { default: worker } = await import('../stremio/worker.js');

const KEY = process.env.WYZIE_KEY;
const ORIGIN = 'https://stremio.wyzie.io';
const TEST_KEY = 'wyzie-' + 'a'.repeat(32); // well-formed, only used offline

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
// Never print a key, a download token or a config segment.
const mask = (s) => String(s).replace(/((?:key|tok|tk)=)[^&\s"]*/gi, '$1***').replace(/wyzie-[a-z0-9]{32}/gi, 'wyzie-***');

// ---- fetch stub: answers /search from `stub` when set, else the real API ----
const realFetch = globalThis.fetch;
let stub = null;
const searches = [];
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://sub.wyzie.io/search')) {
    searches.push(new URL(url));
    if (stub) return stub(new URL(url));
  }
  return realFetch(input, init);
};
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const seg = (cfg) => encodeURIComponent(JSON.stringify(cfg));
async function call(path) {
  const res = await worker.fetch(new Request(ORIGIN + path));
  const type = res.headers.get('content-type') || '';
  return { res, body: type.includes('json') ? await res.json() : await res.text() };
}
async function subs(cfg, id, extra = '', type = id.includes(':') ? 'series' : 'movie') {
  const path = `/${seg(cfg)}/subtitles/${type}/${id}${extra ? '/' + extra : ''}.json`;
  return (await call(path)).body.subtitles || [];
}

// Canned /search rows: real subtitles, then AI rows in the order the API lists
// them (a language's regional variants BEFORE the plain one).
const C = (id, language, extra = {}) => ({
  id: String(id),
  url: `https://sub.wyzie.io/c/abc/id/${id}?format=srt&encoding=UTF-8&id=tt0816692&tok=t`,
  format: 'srt',
  encoding: 'UTF-8',
  display: language,
  language,
  isHearingImpaired: false,
  source: 'charlie',
  release: 'Interstellar.2014.720p.BluRay.x264-DAA',
  ...extra,
});
const AI = (language, display) => ({
  id: 'ai-' + language,
  url: `https://sub.wyzie.io/translate?id=tt0816692&source=all&tk=t&target=${encodeURIComponent(display)}`,
  format: 'srt',
  display,
  language,
  source: 'ai',
  ai: true,
});
const AI_ROWS = [
  AI('en-AU', 'English (Australia)'), AI('en-GB', 'English (United Kingdom)'), AI('en-US', 'English (United States)'), AI('en', 'English'),
  AI('es-AR', 'Spanish (Argentina)'), AI('es-419', 'Spanish (Latin America)'), AI('es-MX', 'Spanish (Mexico)'), AI('es', 'Spanish'),
  AI('fr-CA', 'French (Canada)'),
  AI('pt-BR', 'Portuguese (Brazil)'), AI('pt-PT', 'Portuguese (Portugal)'), AI('pt', 'Portuguese'),
  AI('zh-CN', 'Chinese (China)'), AI('zh-TW', 'Chinese (Taiwan)'), AI('zh-Hant', 'Chinese (Traditional)'), AI('zh', 'Chinese'),
];
const REAL_ROWS = [
  C(1, 'hu'), C(2, 'pl'), C(3, 'en'), C(4, 'es'), C(5, 'pb'), C(6, 'ea'), C(7, 'zt'), C(8, 'sp'), C(9, 'ze'), C(10, 'en'),
];

async function offline() {
  console.log('Manifest + configure page:');
  {
    const { body: m } = await call('/manifest.json');
    ok('version 1.4.1', m.version === '1.4.1', m.version);
    ok('bare manifest needs configuring', m.behaviorHints && m.behaviorHints.configurationRequired === true);
    const { body: mc } = await call(`/${seg({ apiKey: TEST_KEY })}/manifest.json`);
    ok('configured manifest is installable', mc.behaviorHints && !mc.behaviorHints.configurationRequired && mc.behaviorHints.configurable);
    const { res, body: page } = await call('/configure');
    ok('configure page is HTML', res.status === 200 && /text\/html/.test(res.headers.get('content-type')));
    ok("offers Portuguese (Brazil) as pb", page.includes("['pb','Portuguese (Brazil)','br']"));
    ok('pt-BR browsers default to pb', /indexOf\('pt-br'\) === 0 \? 'pb'/.test(page));
    const { body: pre } = await call(`/${seg({ apiKey: TEST_KEY, languages: 'pt-BR,ENG,zh_TW,es-MX,klingon,xx-yy-zz-q' })}/configure`);
    const prefill = JSON.parse(pre.match(/var PREFILL = (\{.*?\});/)[1]);
    ok('prefill languages normalized (pt-BR -> pb, ENG -> en, zh_TW -> zt, junk dropped)', prefill.languages === 'pb,en,zt,es-mx', prefill.languages);
    const { body: srt } = await call('/notice.srt?m=' + encodeURIComponent('Hello\nthere'));
    ok('/notice.srt is a one-cue SRT', /^1\n00:00:00,000 --> 00:00:30,000\nHello there\n$/.test(srt), JSON.stringify(srt));
  }

  console.log('\nLanguage codes sent to /search (offline):');
  {
    stub = () => reply(200, REAL_ROWS);
    searches.length = 0;
    await subs({ apiKey: TEST_KEY, languages: 'pt-BR,zh-TW,zh-Hant,eng,por,es-419,es_MX,fr-CA,klingon,x' }, 'tt0816692');
    const sent = searches[0] && searches[0].searchParams.get('language');
    ok('pt-BR -> pb, zh-TW/zh-Hant -> zt, eng -> en, por -> pt, es-419/es-MX -> es, fr-CA -> fr, junk dropped',
      sent === 'pb,zt,en,pt,es,fr', sent);
    ok('every code is two letters (the API 400s on anything else)', !!sent && sent.split(',').every((c) => /^[a-z]{2}$/.test(c)));
    searches.length = 0;
    await subs({ apiKey: TEST_KEY, languages: 'klingon' }, 'tt0816692');
    ok('no usable code: no language= at all', searches[0] && !searches[0].searchParams.has('language'), searches[0] && mask(searches[0].search));
  }

  console.log('\nNotices (offline):');
  {
    stub = () => reply(400, { code: 400, message: 'Invalid language format', details: 'Languages must be two-letter ISO 639-1 codes' });
    const bad = await subs({ apiKey: TEST_KEY, languages: 'en' }, 'tt0816692');
    ok('a 400 shows the API message, not "service error 400"', bad.length === 1 && /Invalid language format/.test(bad[0].lang) && !/service error/.test(bad[0].lang), bad[0] && bad[0].lang);
    ok('notice url is /notice.srt', bad[0] && bad[0].url.startsWith(ORIGIN + '/notice.srt?m='));
    stub = () => reply(400, { message: 'No subtitles found' });
    const none = await subs({ apiKey: TEST_KEY }, 'tt0816692');
    ok('400 No subtitles found -> "no subtitles found" notice', none.length === 1 && none[0].id === 'wyzie-notice-empty');
    stub = () => { throw new TypeError('fetch failed'); };
    const down = await subs({ apiKey: TEST_KEY }, 'tt0816692');
    ok('network error -> neterr notice', down.length === 1 && down[0].id === 'wyzie-notice-neterr');
    stub = () => reply(200, REAL_ROWS);
    searches.length = 0;
    const noep = await subs({ apiKey: TEST_KEY }, 'tt0944947', '', 'series');
    ok('series without season/episode -> noep notice, no search', noep[0] && noep[0].id === 'wyzie-notice-noep' && searches.length === 0);
    const nokey = await subs({}, 'tt0816692');
    ok('no key -> nokey notice', nokey[0] && nokey[0].id === 'wyzie-notice-nokey');
    const badkey = await subs({ apiKey: 'nope' }, 'tt0816692');
    ok('malformed key -> invalid key notice', badkey[0] && /invalid API key/.test(badkey[0].lang));
  }

  console.log('\nSubtitle URLs + Stremio language codes (offline):');
  {
    stub = () => reply(200, REAL_ROWS);
    const list = await subs({ apiKey: TEST_KEY }, 'tt0816692');
    ok('every url is the Wyzie link itself (no 127.0.0.1:11470 proxy)', list.length > 0 && list.every((s) => s.url.startsWith('https://sub.wyzie.io/')), list[0] && mask(list[0].url));
    const lang = (id) => (list.find((s) => s.id.endsWith('charlie-' + id)) || {}).lang;
    ok('pb -> pob, ea -> spl, zt -> zht, sp -> spa, ze -> chi', lang(5) === 'pob' && lang(6) === 'spl' && lang(7) === 'zht' && lang(8) === 'spa' && lang(9) === 'chi',
      [5, 6, 7, 8, 9].map(lang).join(','));
    ok('en -> eng, hu -> hun', lang(3) === 'eng' && lang(1) === 'hun');
  }

  console.log('\nAI rows: the exact language, not the first variant (offline):');
  {
    stub = () => reply(200, REAL_ROWS.concat(AI_ROWS));
    const list = await subs({ apiKey: TEST_KEY, languages: 'en,es,pt,pb,zt,fr', ai: true }, 'tt0816692');
    const ai = list.filter((s) => s.id.includes('-ai-'));
    const target = (s) => decodeURIComponent(new URL(s.url).searchParams.get('target'));
    const targets = ai.map(target);
    ok('one AI row per configured language', ai.length === 6, targets.join(' | '));
    ok('en -> English (not Australia)', targets.includes('English') && !targets.includes('English (Australia)'));
    ok('es -> Spanish (not Argentina)', targets.includes('Spanish') && !targets.includes('Spanish (Argentina)'));
    ok('pt -> Portuguese and pb -> Portuguese (Brazil)', targets.includes('Portuguese') && targets.includes('Portuguese (Brazil)'));
    ok('zt -> Chinese (Taiwan)', targets.includes('Chinese (Taiwan)'));
    ok('fr with no plain row -> its variant', targets.includes('French (Canada)'));
    const byTarget = Object.fromEntries(ai.map((s) => [target(s), s.lang]));
    ok('AI langs: pt-BR -> pob, zh-TW -> zht, en -> eng', byTarget['Portuguese (Brazil)'] === 'pob' && byTarget['Chinese (Taiwan)'] === 'zht' && byTarget.English === 'eng');
    ok('AI ids unique + title-scoped', new Set(ai.map((s) => s.id)).size === ai.length && ai.every((s) => s.id.startsWith('wyzie-tt0816692-ai-')));
    ok('AI rows listed after real ones', list.findIndex((s) => s.id.includes('-ai-')) === list.length - ai.length);
    const regional = await subs({ apiKey: TEST_KEY, languages: 'es-MX', ai: true }, 'tt0816692');
    ok('es-mx -> Spanish (Mexico)', regional.filter((s) => s.id.includes('-ai-')).map(target).join() === 'Spanish (Mexico)');
    const off = await subs({ apiKey: TEST_KEY, languages: 'en' }, 'tt0816692');
    ok('AI off -> no AI rows', !off.some((s) => s.id.includes('-ai-')));
  }

  console.log('\nDual copies only in the user\'s languages (offline):');
  {
    stub = () => reply(200, REAL_ROWS);
    const dualOf = (list) => list.filter((s) => s.id.includes('-dual-'));
    const idOf = (s) => s.id.replace(/-dual-.*$/, '').replace(/^.*charlie-/, '');
    const none = dualOf(await subs({ apiKey: TEST_KEY, dual: 'es' }, 'tt0816692'));
    ok('no languages set: English rows only', none.length === 2 && none.every((s) => s.lang === 'eng'), none.map(idOf).join());
    const pl = dualOf(await subs({ apiKey: TEST_KEY, languages: 'pl,es', dual: 'es' }, 'tt0816692'));
    ok('languages pl,es + dual es: only the Polish row', pl.length === 1 && idOf(pl[0]) === '2', pl.map(idOf).join());
    const pt = dualOf(await subs({ apiKey: TEST_KEY, languages: 'pt,en', dual: 'pb' }, 'tt0816692'));
    ok('dual pb: no copy of a pb row, English rows get one', pt.length === 2 && pt.every((s) => s.lang === 'eng' && /[?&]dual=pb\b/.test(s.url)), pt.map(idOf).join());
    ok('dual label names Brazilian Portuguese', pt[0] && /\+ Brazilian Portuguese|\+ Portuguese \(Brazil\)/.test(pt[0].name), pt[0] && pt[0].name);
  }

  console.log('\nExtras segment decoded once (offline):');
  {
    stub = () => reply(200, [
      C(1, 'en', { release: 'Tom.and.Jerry.720p.HDTV.x264-OTHER' }),
      C(2, 'en', { release: 'Tom.and.Jerry.1080p.WEB-DL.x264-GRP' }),
    ]);
    const file = 'Tom & Jerry 100% 1080p WEB-DL x264-GRP.mkv';
    const extra = `videoHash=abc&videoSize=123&filename=${encodeURIComponent(file)}`;
    const list = await subs({ apiKey: TEST_KEY, languages: 'en' }, 'tt0816692', extra);
    ok('filename with "&" and "%" still matches its release (✓ first)', list[0] && list[0].id.endsWith('charlie-2') && list[0].name.startsWith('✓ '), list[0] && list[0].name);
    const plus = await subs({ apiKey: TEST_KEY, languages: 'en' }, 'tt0816692', 'filename=Tom+and+Jerry+1080p+WEB-DL-GRP.mkv');
    ok('form-encoded extras ("+" for spaces) still match', plus[0] && plus[0].id.endsWith('charlie-2'));
  }
  stub = null;
}

async function live() {
  console.log('\nLive — movie, AI rows exact (needs a Pro key):');
  {
    const list = await subs({ apiKey: KEY, languages: 'en,es,pt,pt-BR', ai: true }, 'tt0816692');
    const real = list.filter((s) => !s.id.includes('-ai-') && !s.id.startsWith('wyzie-notice'));
    ok('real subtitles returned (no notice)', real.length > 0, list[0] && mask(list[0].lang));
    ok('every url is a direct https://sub.wyzie.io link', list.every((s) => s.url.startsWith('https://sub.wyzie.io/')));
    const targets = list.filter((s) => s.id.includes('-ai-')).map((s) => decodeURIComponent(new URL(s.url).searchParams.get('target')));
    if (!targets.length) console.log('    (no AI rows: WYZIE_KEY is not a Pro key, AI checks skipped)');
    else {
      ok('AI en/es/pt/pb -> English, Spanish, Portuguese, Portuguese (Brazil)',
        ['English', 'Spanish', 'Portuguese', 'Portuguese (Brazil)'].every((t) => targets.includes(t)) && targets.length === 4, targets.join(' | '));
    }
  }

  console.log('\nLive — series, hand-typed codes (eng, zh-TW):');
  {
    const list = await subs({ apiKey: KEY, languages: 'eng,zh-TW' }, 'tt0944947:1:1');
    ok('no 400 notice', !list.some((s) => /400|rejected/.test(s.lang)), list[0] && mask(list[0].lang));
    ok('English subtitles returned (eng)', list.some((s) => s.lang === 'eng' && !s.id.startsWith('wyzie-notice')));
  }

  console.log('\nLive — invalid key:');
  {
    const list = await subs({ apiKey: 'wyzie-' + '0'.repeat(32) }, 'tt0816692');
    ok('one "invalid API key" notice', list.length === 1 && /invalid API key/.test(list[0].lang), list[0] && list[0].lang);
  }
}

try {
  await offline();
  if (KEY) await live();
  else console.log('\n(set WYZIE_KEY for the live checks)');
} catch (e) {
  console.error('crashed:', mask(e && e.stack || e));
  fail++;
}
console.log(`\n${'='.repeat(40)}\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
