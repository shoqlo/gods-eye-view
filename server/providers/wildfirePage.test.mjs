import test from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  IMAGERY_ORIGINS,
  WILDFIRE_PAGE_CSP,
  WILDFIRE_PAGE_HTML,
  WILDFIRE_PAGE_PATH,
  wildfirePage,
} from './wildfirePage.js';
import { RISK_BANDS } from '../../src/wildfire/risk.js';

const APP_FILE = new URL('../../src/wildfire/finderPage.js', import.meta.url);
const FINDER_FILE = new URL('../../src/wildfire/finder.js', import.meta.url);
const APP_JS = readFileSync(APP_FILE, 'utf8');
const FINDER_JS = readFileSync(FINDER_FILE, 'utf8');
/** Everything the browser receives from this route. */
const SERVED = [WILDFIRE_PAGE_HTML, APP_JS, FINDER_JS].join('\n');

/** A minimal request/response pair: enough for the route's own decisions. */
function exchange({ method = 'GET', url = '/' } = {}) {
  const res = {
    status: null,
    headers: null,
    body: undefined,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  return { req: { method, url }, res };
}

/** Run the plugin's dev-server middleware for one path. */
function serve(options) {
  let mounted = null;
  const plugin = wildfirePage();
  plugin.configureServer({
    middlewares: {
      use(path, handler) {
        mounted = { path, handler };
      },
    },
  });
  assert.equal(mounted.path, WILDFIRE_PAGE_PATH);
  const { req, res } = exchange(options);
  mounted.handler(req, res);
  return res;
}

test('the page mounts at /wildfire on both the dev and preview servers', () => {
  const plugin = wildfirePage();
  const mounted = [];
  for (const key of ['configureServer', 'configurePreviewServer']) {
    plugin[key]({
      middlewares: {
        use(path) {
          mounted.push(path);
        },
      },
    });
  }
  assert.deepEqual(mounted, ['/wildfire', '/wildfire']);
});

test('GET / serves the document with its own strict policy', () => {
  const res = serve();
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(
    res.headers['Referrer-Policy'],
    'strict-origin-when-cross-origin',
  );
  assert.equal(res.headers['Content-Security-Policy'], WILDFIRE_PAGE_CSP);
  assert.equal(typeof res.body, 'string');
  assert.match(res.body, /<title>Wildfire Watch<\/title>/);
});

test('the policy allows scripts from this origin only and no framing', () => {
  const directives = Object.fromEntries(
    WILDFIRE_PAGE_CSP.split('; ').map((directive) => {
      const [name, ...values] = directive.split(' ');
      return [name, values];
    }),
  );
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['default-src'], ["'none'"]);
  assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
  assert.deepEqual(directives['connect-src'], ["'self'", ...IMAGERY_ORIGINS]);
});

test('the two scripts are served as modules from the real source files', () => {
  for (const [path, file] of [
    ['/app.js', APP_JS],
    ['/finder.js', FINDER_JS],
  ]) {
    const res = serve({ url: path });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['Content-Type'], 'text/javascript; charset=utf-8');
    assert.equal(res.body, file);
  }
  assert.match(WILDFIRE_PAGE_HTML, /<script type="module" src="\/wildfire\/app\.js"><\/script>/);
  assert.match(APP_JS, /from '\.\/finder\.js'/);
});

test('the document has no inline script', () => {
  const scripts = [...WILDFIRE_PAGE_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /src="/);
    assert.equal(body.trim(), '');
  }
  assert.doesNotMatch(WILDFIRE_PAGE_HTML, /\son[a-z]+="/i, 'no inline event handlers');
});

test('the page script parses', () => {
  for (const file of [APP_FILE, FINDER_FILE]) {
    const result = spawnSync(process.execPath, ['--check', file.pathname], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('HEAD returns the headers without a body', () => {
  const res = serve({ method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
});

test('a deep path under the mount is a 404, not the document', () => {
  for (const url of ['/secrets', '/app.js/x', '/../package.json', '/finder.test.mjs']) {
    const res = serve({ url });
    assert.equal(res.status, 404, url);
  }
});

test('a write method is refused with 405 and an Allow header', () => {
  const res = serve({ method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.Allow, 'GET');
});

test('HEAD answers the scripts without a body too', () => {
  const res = serve({ method: 'HEAD', url: '/app.js' });
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
});

test('the page reads only the fire list, fire weather and place search', () => {
  const endpoints = [...SERVED.matchAll(/\/api\/[\w-]+(?:\/[\w-]+)*/g)].map(
    (match) => match[0],
  );
  assert.deepEqual([...new Set(endpoints)].sort(), [
    '/api/fire-risk',
    '/api/fire-weather',
    '/api/geocode',
  ]);
});

test('nothing served carries a credential, token or key name', () => {
  for (const forbidden of [
    'api_key',
    'apiKey',
    'MAP_KEY',
    'token',
    'secret',
    'password',
    'Authorization',
  ]) {
    assert.equal(SERVED.includes(forbidden), false, `must not mention ${forbidden}`);
  }
});

test('every band choice the page offers is one the index knows', () => {
  const select = WILDFIRE_PAGE_HTML.slice(
    WILDFIRE_PAGE_HTML.indexOf('<select id="band">'),
    WILDFIRE_PAGE_HTML.indexOf('</select>', WILDFIRE_PAGE_HTML.indexOf('<select id="band">')),
  );
  const ids = [...select.matchAll(/<option value="([a-z]*)">/g)].map((match) => match[1]);
  assert.equal(ids[0], '');
  const known = new Set(RISK_BANDS.map((band) => band.id));
  for (const id of ids.slice(1)) assert.ok(known.has(id), id);
});

test('the page states what it is not', () => {
  assert.match(WILDFIRE_PAGE_HTML, /not a fire-spread forecast/);
  assert.match(WILDFIRE_PAGE_HTML, /not a life-safety (product|tool)/);
  assert.match(WILDFIRE_PAGE_HTML, /OpenStreetMap contributors/);
  assert.match(APP_JS, /not an official fire-danger rating/);
});

test('the document links only to itself, its script and the globe', () => {
  const hrefs = [...WILDFIRE_PAGE_HTML.matchAll(/(?:href|src)="([^"]*)"/g)].map(
    (match) => match[1],
  );
  const internal = [...new Set(hrefs.filter((href) => !href.startsWith('data:')))].sort();
  assert.deepEqual(internal, ['#help', '#results', '/', '/wildfire/app.js']);
});

test('the scripts reach only the outside hosts the policy names', () => {
  const urls = [...SERVED.matchAll(/https?:\/\/[^\s"'`<>)]+/g)].map((match) => match[0]);
  const hosts = [...new Set(urls.map((url) => new URL(url).host))].sort();
  assert.deepEqual(hosts, [
    'cameras.alertcalifornia.org',
    'gibs.earthdata.nasa.gov',
    'www.google.com',
    'www.w3.org',
  ]);
  // Google Maps is a link the reader follows, and w3.org is the SVG namespace;
  // the two hosts the page fetches from are exactly the policy's.
  assert.deepEqual(
    IMAGERY_ORIGINS.map((origin) => new URL(origin).host).sort(),
    ['cameras.alertcalifornia.org', 'gibs.earthdata.nasa.gov'],
  );
});

test('the location view asks NASA for the layers it promises', () => {
  for (const layer of [
    'HLS_S30_Nadir_BRDF_Adjusted_Reflectance',
    'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1',
    'VIIRS_SNPP_Thermal_Anomalies_375m_All',
  ]) {
    assert.ok(APP_JS.includes(layer), `page must request ${layer}`);
  }
});

test('the location view is honest about what it is and who supplies it', () => {
  assert.match(APP_JS, /not live video/);
  assert.match(WILDFIRE_PAGE_HTML, /NASA GIBS/);
  assert.match(SERVED, /ALERTCalifornia/);
  assert.match(APP_JS, /covers California only/);
  assert.match(APP_JS, /may not be looking at the fire/);
});

test('nothing served builds markup from strings', () => {
  for (const pattern of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
    assert.equal(APP_JS.includes(pattern), false, `app.js uses ${pattern}`);
    assert.equal(FINDER_JS.includes(pattern), false, `finder.js uses ${pattern}`);
  }
});

test('the finder module stays importable by the browser: no imports of its own', () => {
  assert.doesNotMatch(FINDER_JS, /^\s*import\s/m);
});
