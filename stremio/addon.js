const { addonBuilder } = require('stremio-addon-sdk');

const WYZIE_BASE = process.env.WYZIE_BASE || 'https://sub.wyzie.io';

const manifest = {
  id: 'io.wyzie.subs',
  version: '1.0.0',
  name: 'Wyzie Subs',
  description:
    'Free subtitles in 80+ languages from Wyzie Subs. Aggregates OpenSubtitles, SubDL, Podnapisi and more. Get a free key at store.wyzie.io/redeem.',
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
      title: 'Prefer hearing-impaired subtitles',
      required: false,
    },
  ],
};

const builder = new addonBuilder(manifest);

function parseStremioId(id) {
  // Movies:  tt1234567
  // Series:  tt1234567:1:2  (imdb : season : episode)
  const [imdb, season, episode] = id.split(':');
  return { imdb, season, episode };
}

function mapToStremioSubs(items) {
  return items
    .filter((s) => s && s.url)
    .map((s) => ({
      id: String(s.id),
      url: s.url,
      lang: s.language || 'en',
      // Stremio uses .display in its UI; pack source for transparency
      name: `${s.display || s.language} / ${s.source || 'wyzie'}${s.ai ? ' (AI)' : ''}`,
    }));
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
  if (config.hi) url.searchParams.set('hi', 'true');
  // Stremio's player handles srt and vtt natively; ask Wyzie to bias srt.
  url.searchParams.set('format', 'srt');

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'wyzie-stremio/1.0' },
    });
    if (!res.ok) {
      // 402/429: surface a single "subtitle" that links the user to the upgrade page.
      if (res.status === 402 || res.status === 429) {
        return {
          subtitles: [
            {
              id: 'wyzie-upsell',
              url: 'https://store.wyzie.io/#plans',
              lang: 'eng',
              name:
                res.status === 402
                  ? 'Wyzie: out of requests. Top up at store.wyzie.io'
                  : 'Wyzie: daily limit hit. Upgrade for more',
            },
          ],
          cacheMaxAge: 60,
        };
      }
      return { subtitles: [] };
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.subtitles || [];
    return {
      subtitles: mapToStremioSubs(list),
      cacheMaxAge: 60 * 60,
      staleRevalidate: 60 * 60 * 6,
      staleError: 60 * 60 * 24,
    };
  } catch (err) {
    console.error('[wyzie-stremio] fetch failed', err);
    return { subtitles: [] };
  }
});

module.exports = builder.getInterface();
