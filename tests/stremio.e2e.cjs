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
    }

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

    console.log('\nSubtitles — series:');
    {
      const r = await fetch(`${root}/${cfg}/subtitles/series/${SERIES}.json`);
      const data = await r.json();
      const subs = data.subtitles || [];
      ok('HTTP 200', r.status === 200, `got ${r.status}`);
      ok('returns subtitles', subs.length >= 1, `got ${subs.length}`);
    }

    console.log('\nNo-config request (no apiKey):');
    {
      const r = await fetch(`${root}/subtitles/movie/${MOVIE}.json`);
      const data = await r.json();
      ok(
        'HTTP 200 and empty list',
        r.status === 200 && (data.subtitles || []).length === 0,
        `status ${r.status}, ${(data.subtitles || []).length} subs`,
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
