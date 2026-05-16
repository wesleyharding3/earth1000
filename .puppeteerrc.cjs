// Puppeteer config — pinned cache directory.
//
// Render's filesystem is ephemeral outside the project src tree: anything
// the build phase downloads into ~/.cache (Puppeteer's default) gets
// wiped before the runtime phase starts, so the postinstall'd Chrome
// disappears by the time the server tries to launch it.
//
// Pointing Puppeteer at ./.cache/puppeteer inside the project keeps the
// downloaded Chrome inside the deploy artifact, surviving the build→
// runtime handoff.

const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
