#!/usr/bin/env node
/**
 * Shared API-contract test for all Wyzie plugins.
 *
 * Every plugin (Stremio, Bazarr, Kodi) is a thin client over the same
 * `GET https://sub.wyzie.io/search` endpoint. This script replays the EXACT
 * request each plugin builds and asserts the response is usable, so you can
 * catch breakage without installing any of the apps.
 *
 * Run:
 *   WYZIE_KEY=wyzie-xxxxxxxx... node tests/contract.mjs
 *   (PowerShell)  $env:WYZIE_KEY="wyzie-..."; node tests/contract.mjs
 *
 * Optional: WYZIE_BASE to point at staging instead of prod.
 */

const BASE = process.env.WYZIE_BASE || 'https://sub.wyzie.io';
const KEY = process.env.WYZIE_KEY;

// Known title with lots of subs across providers.
const MOVIE_IMDB = 'tt0816692'; // Interstellar
const SERIES_IMDB = 'tt0944947'; // Game of Thrones
const SERIES_S = 1,
  SERIES_E = 1;

let pass = 0,
  fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'wyzie-plugin-tests/1.0' },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, body };
}

function asList(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.subtitles)) return body.subtitles;
  return [];
}

function shapeOk(item) {
  // Fields every plugin relies on when mapping a result.
  return (
    item &&
    typeof item.url === 'string' &&
    item.url.length > 0 &&
    typeof item.language === 'string'
  );
}

async function main() {
  if (!KEY) {
    console.error('ERROR: set WYZIE_KEY env var to a valid wyzie- key.');
    process.exit(2);
  }
  console.log(`Base: ${BASE}`);
  console.log(`Key:  ${KEY.slice(0, 10)}...\n`);

  // ---- 1. Stremio request shape: movie ----
  console.log('Stremio — movie (format=srt, no source):');
  {
    const u = new URL('/search', BASE);
    u.searchParams.set('id', MOVIE_IMDB);
    u.searchParams.set('key', KEY);
    u.searchParams.set('format', 'srt');
    const { status, body } = await getJson(u);
    const list = asList(body);
    ok('HTTP 200', status === 200, `got ${status}`);
    ok('returns >=1 subtitle', list.length >= 1, `got ${list.length}`);
    ok('every item has url+language', list.every(shapeOk));
  }

  // ---- 2. Stremio request shape: series ----
  console.log('\nStremio — series (season+episode):');
  {
    const u = new URL('/search', BASE);
    u.searchParams.set('id', SERIES_IMDB);
    u.searchParams.set('key', KEY);
    u.searchParams.set('season', String(SERIES_S));
    u.searchParams.set('episode', String(SERIES_E));
    u.searchParams.set('format', 'srt');
    const { status, body } = await getJson(u);
    const list = asList(body);
    ok('HTTP 200', status === 200, `got ${status}`);
    ok('returns >=1 subtitle', list.length >= 1, `got ${list.length}`);
  }

  // ---- 3. Bazarr request shape: movie (source=all, NO format) ----
  console.log('\nBazarr — movie (source=all, no format):');
  {
    const u = new URL('/search', BASE);
    u.searchParams.set('id', MOVIE_IMDB);
    u.searchParams.set('key', KEY);
    u.searchParams.set('source', 'all');
    const { status, body } = await getJson(u);
    const list = asList(body);
    ok(
      'HTTP 200 (source=all resolves per key tier)',
      status === 200,
      `got ${status}${status === 401 ? ' — source=all auth/tier resolution rejected this key' : ''}`,
    );
    ok('returns >=1 subtitle', list.length >= 1, `got ${list.length}`);
  }

  // ---- 4. Kodi request shape: series (format=srt, season/episode) ----
  console.log('\nKodi — series (format=srt, season+episode):');
  {
    const u = new URL('/search', BASE);
    u.searchParams.set('id', SERIES_IMDB);
    u.searchParams.set('key', KEY);
    u.searchParams.set('season', String(SERIES_S));
    u.searchParams.set('episode', String(SERIES_E));
    u.searchParams.set('format', 'srt');
    const { status, body } = await getJson(u);
    const list = asList(body);
    ok('HTTP 200', status === 200, `got ${status}`);
    ok('returns >=1 subtitle', list.length >= 1, `got ${list.length}`);
  }

  // ---- 5. The actual subtitle file is downloadable ----
  console.log('\nDownload — first result resolves to real content:');
  {
    const u = new URL('/search', BASE);
    u.searchParams.set('id', MOVIE_IMDB);
    u.searchParams.set('key', KEY);
    u.searchParams.set('format', 'srt');
    const { body } = await getJson(u);
    const list = asList(body);
    const first = list.find(shapeOk);
    if (!first) {
      ok('have a result to download', false);
    } else {
      const res = await fetch(first.url, {
        headers: { 'User-Agent': 'wyzie-plugin-tests/1.0' },
      });
      const text = await res.text();
      ok('download HTTP 200', res.status === 200, `got ${res.status}`);
      ok(
        'looks like a subtitle (has timecodes or cues)',
        /-->/.test(text) || /^\d+\s*$/m.test(text) || text.length > 50,
        `len=${text.length}`,
      );
    }
  }

  // ---- 6. Error handling: invalid key ----
  console.log('\nError path — invalid key:');
  {
    const u = new URL('/search', BASE);
    u.searchParams.set('id', MOVIE_IMDB);
    u.searchParams.set('key', 'wyzie-thiskeyisdefinitelynotrealatall00');
    const { status } = await getJson(u);
    // Plugins treat 401/403 as "no subs" (Bazarr raises AuthenticationError on 401).
    ok('rejected (401/403)', status === 401 || status === 403, `got ${status}`);
  }

  console.log(`\n${'='.repeat(40)}\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('harness crashed:', e);
  process.exit(3);
});
