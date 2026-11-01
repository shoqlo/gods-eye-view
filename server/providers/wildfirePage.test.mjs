import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WILDFIRE_PAGE_HTML,
  WILDFIRE_PAGE_PATH,
  wildfirePage,
} from './wildfirePage.js';

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

test('GET / serves the document as html with the headers a shared link needs', () => {
  const res = serve();
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(
    res.headers['Referrer-Policy'],
    'strict-origin-when-cross-origin',
  );
  assert.equal(typeof res.body, 'string');
  assert.match(res.body, /<title>Wildfire Watch/);
});

test('HEAD returns the headers without a body', () => {
  const res = serve({ method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
});

test('a deep path under the mount is a 404, not the document', () => {
  const res = serve({ url: '/anything' });
  assert.equal(res.status, 404);
  assert.equal(res.body, 'Not found');
});

test('a write method is refused with 405 and an Allow header', () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = serve({ method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.Allow, 'GET');
  }
});

test('the page reads the public index and no other endpoint', () => {
  const endpoints = [
    ...WILDFIRE_PAGE_HTML.matchAll(/\/api\/[\w-]+(?:\/[\w-]+)*/g),
  ].map((match) => match[0]);
  assert.deepEqual([...new Set(endpoints)], ['/api/fire-risk']);
});

test('the document carries no credential, token or key name', () => {
  // A public page is one copy-paste away from being a leak, so the document is
  // checked for the names of every key the app brokers, not just the obvious
  // ones. `MAP_KEY` is included because FIRMS is the feed this page lives on.
  for (const forbidden of [
    'api_key',
    'apiKey',
    'MAP_KEY',
    'token',
    'secret',
    'password',
    'Authorization',
  ]) {
    assert.equal(
      WILDFIRE_PAGE_HTML.includes(forbidden),
      false,
      `page must not mention ${forbidden}`,
    );
  }
});

test('every band choice the page offers is one the index knows', () => {
  const options = [
    ...WILDFIRE_PAGE_HTML.matchAll(
      /<option value="([a-z]+)">([^<]+)<\/option>/g,
    ),
  ].map((match) => ({ id: match[1], label: match[2] }));
  assert.deepEqual(
    options.map((option) => option.id),
    ['all', 'watch', 'elevated', 'high'],
  );
  for (const option of options) {
    assert.ok(option.label.length > 0);
  }
});

test('the page states what it is not, in the same words as the panel', () => {
  assert.match(WILDFIRE_PAGE_HTML, /not a fire-spread forecast/);
  assert.match(WILDFIRE_PAGE_HTML, /not a life-safety product/);
  assert.match(WILDFIRE_PAGE_HTML, /OpenStreetMap contributors/);
});

test('the page makes no request outside the public allowlist', () => {
  // One internal link (to the app) and one inline icon. The location view's
  // external requests are built in script, so only the static document is
  // checked here; the next test checks the hosts it may reach.
  const hrefs = [...WILDFIRE_PAGE_HTML.matchAll(/(?:href|src)="([^"]*)"/g)].map(
    (match) => match[1],
  );
  const internal = hrefs.filter((href) => href.startsWith('/'));
  assert.deepEqual(internal, ['/']);
  assert.ok(hrefs.some((href) => href.startsWith('data:image/svg+xml')));
});

test('the location view reaches only the imagery hosts it declares', () => {
  const urls = [...WILDFIRE_PAGE_HTML.matchAll(/https?:\/\/[^\s"'`]+/g)].map(
    (match) => match[0],
  );
  const hosts = [...new Set(urls.map((url) => new URL(url).host))].sort();
  assert.deepEqual(hosts, [
    'cameras.alertcalifornia.org',
    'gibs.earthdata.nasa.gov',
    'www.google.com',
    'www.w3.org',
  ]);
});

test('the location view asks NASA for the layers it promises', () => {
  for (const layer of [
    'HLS_S30_Nadir_BRDF_Adjusted_Reflectance',
    'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1',
    'VIIRS_SNPP_Thermal_Anomalies_375m_All',
  ]) {
    assert.ok(WILDFIRE_PAGE_HTML.includes(layer), `page must request ${layer}`);
  }
});

test('the location view is honest about what it is and who supplies it', () => {
  assert.match(WILDFIRE_PAGE_HTML, /not live video/);
  assert.match(WILDFIRE_PAGE_HTML, /NASA GIBS/);
  assert.match(WILDFIRE_PAGE_HTML, /ALERTCalifornia/);
  assert.match(WILDFIRE_PAGE_HTML, /covers California only/);
  assert.match(WILDFIRE_PAGE_HTML, /may not be looking at the fire/);
});

test('the page builds rows with textContent, never innerHTML', () => {
  assert.equal(WILDFIRE_PAGE_HTML.includes('innerHTML'), false);
  assert.equal(WILDFIRE_PAGE_HTML.includes('insertAdjacentHTML'), false);
  assert.equal(WILDFIRE_PAGE_HTML.includes('document.write'), false);
});
