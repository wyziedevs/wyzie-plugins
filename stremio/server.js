const { serveHTTP, publishToCentral } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const port = Number(process.env.PORT || 7000);

serveHTTP(addonInterface, { port }).then(({ url }) => {
  console.log(`Wyzie Stremio addon running at ${url}`);
  if (process.env.PUBLISH_URL) {
    publishToCentral(process.env.PUBLISH_URL).catch((e) =>
      console.error('publishToCentral failed', e),
    );
  }
});
