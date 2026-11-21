import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WILDFIRE_DEFAULT_LAYER_IDS,
  WILDFIRE_LAYER_IDS,
  WILDFIRE_SKIN_PATH,
  isWildfireLayer,
  isWildfireSkin,
} from './skin.js';

test('the skin owns exactly one path, with or without a trailing slash', () => {
  assert.equal(WILDFIRE_SKIN_PATH, '/fire');
  assert.equal(isWildfireSkin('/fire'), true);
  assert.equal(isWildfireSkin('/fire/'), true);
  assert.equal(isWildfireSkin('/fire//'), true);
});

test('the full console and the public list are never the skin', () => {
  for (const path of ['/', '/wildfire', '/wildfire/', '/firehose', '/fire/x']) {
    assert.equal(isWildfireSkin(path), false, path);
  }
});

test('a missing or malformed path is not the skin', () => {
  for (const value of [undefined, null, '', 42, {}, []]) {
    assert.equal(isWildfireSkin(value), false, String(value));
  }
});

test('the skin keeps fires, their perimeter, wind and the scored assets', () => {
  for (const id of [
    'fire-perimeters',
    'local-firms',
    'wind',
    'local-datacenters',
    'local-dams',
  ]) {
    assert.equal(isWildfireLayer(id), true, id);
  }
});

test('the skin starts with the fire layers, not the exposure packs', () => {
  assert.deepEqual(
    [...WILDFIRE_DEFAULT_LAYER_IDS],
    ['fire-perimeters', 'local-firms', 'wind'],
  );
  for (const id of WILDFIRE_DEFAULT_LAYER_IDS) {
    assert.equal(isWildfireLayer(id), true, id);
  }
  assert.equal(WILDFIRE_DEFAULT_LAYER_IDS.includes('local-datacenters'), false);
  assert.ok(Object.isFrozen(WILDFIRE_DEFAULT_LAYER_IDS));
});

test('the skin does not keep the unrelated layers', () => {
  for (const id of [
    'flights',
    'military',
    'ais-live-vessels',
    'satellites',
    'cctv',
    'street-level',
    'earthquakes',
    'traffic',
  ]) {
    assert.equal(isWildfireLayer(id), false, id);
  }
  assert.equal(WILDFIRE_LAYER_IDS.length, 5);
  assert.ok(Object.isFrozen(WILDFIRE_LAYER_IDS));
});
