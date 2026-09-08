const { load } = require('cheerio');

/** Minimal DOM-shaped adapter for only the Playwright calls HTMLMapper uses. */
function createCheerioPage(html) {
  const $ = load(html);
  const snapshot = node => Object.freeze({ textContent: $(node).text(), outerHTML: $.html(node) });
  const handle = node => ({
    $$(selector) { return Promise.resolve($(node).find(selector).toArray().map(handle)); },
    textContent() { return Promise.resolve($(node).text()); },
    evaluate(callback) { return Promise.resolve(callback(snapshot(node))); }
  });
  return {
    $$(selector) { return Promise.resolve($(selector).toArray().map(handle)); },
    $$eval(selector, callback) { return Promise.resolve(callback($(selector).toArray().map(snapshot))); }
  };
}

module.exports = { createCheerioPage };
