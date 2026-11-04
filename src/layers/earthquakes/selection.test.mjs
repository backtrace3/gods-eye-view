import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesLayer } from './index.js';
import {
  EARTHQUAKE_CARD_SOURCE_ID,
  buildEarthquakeCard,
  formatQuakeAge,
  magnitudeClass,
} from './cards.js';

const NOW = Date.UTC(2026, 10, 4, 18, 0, 0);
const rows = [
  {
    stableId: 'us7000aaaa',
    usgsId: 'us7000aaaa',
    lon: -117.6,
    lat: 35.6,
    depthKm: 8.2,
    mag: 4.6,
    place: '12 km SW of Ridgecrest, CA',
    time: NOW - 2 * 3600000,
  },
  {
    stableId: 'us7000bbbb',
    usgsId: 'us7000bbbb',
    lon: 142.1,
    lat: 38.3,
    depthKm: 410,
    mag: 5.3,
    place: 'off the east coast of Honshu, Japan',
    time: NOW - 5 * 60000,
  },
];

function harness({ snapshots = [rows], owners = new Set() } = {}) {
  const published = [];
  const visible = new Map();
  let clickAction = null;
  let destroyed = 0;
  let nextPick = null;
  let pointerFree = true;
  let labelHit = null;
  const hitTests = [];
  const viewer = {
    dataSources: { add() {}, remove() {} },
    scene: { canvas: {}, pick: () => nextPick },
  };
  let call = 0;
  const layer = createEarthquakesLayer({
    source: {
      getSnapshot: async () =>
        snapshots[Math.min(call++, snapshots.length - 1)],
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        published.push({ sourceId, entries });
      },
      setVisible(sourceId, value) {
        visible.set(sourceId, value);
      },
      clearSource(sourceId) {
        published.push({ sourceId, entries: [] });
      },
      hitTest(x, y, options) {
        hitTests.push(options);
        return labelHit;
      },
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(action) {
        clickAction = action;
      },
      destroy() {
        destroyed++;
        clickAction = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id?.id ?? null,
      isOwnedByOtherLayer: (_layerId, pickId) => owners.has(pickId),
    },
    pointer: { isPointerFree: () => pointerFree },
    now: () => NOW,
  });
  layer.init(viewer);
  layer.enable(viewer);
  const cards = () =>
    published.filter((p) => p.sourceId === EARTHQUAKE_CARD_SOURCE_ID);
  return {
    layer,
    viewer,
    visible,
    cards,
    lastCard: () => cards().at(-1)?.entries ?? null,
    labels: () =>
      published.filter((p) => p.sourceId === 'earthquakes').at(-1)?.entries ??
      [],
    hitTests,
    click(pick) {
      nextPick = pick;
      clickAction?.({ position: { x: 10, y: 10 } });
    },
    clickLabel(entryId) {
      labelHit = { sourceId: 'earthquakes', entryId };
      nextPick = null;
      clickAction?.({ position: { x: 10, y: 10 } });
      labelHit = null;
    },
    setPointerFree(value) {
      pointerFree = value;
    },
    get hasHandler() {
      return clickAction !== null;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

const pickQuake = (id) => ({ id: { id: `earthquake:${id}` } });

test('clicking an earthquake shows its details card', async () => {
  const h = harness();
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.visible.get(EARTHQUAKE_CARD_SOURCE_ID), true);
  h.click(pickQuake('us7000aaaa'));
  const entries = h.lastCard();
  assert.equal(entries.length, 1);
  const [card] = entries;
  assert.equal(card.id, 'earthquake-card:us7000aaaa');
  assert.equal(card.title, 'QUAKE · M4.6');
  assert.deepEqual(card.details, [
    '12 km SW of Ridgecrest, CA',
    'Light · 8 km deep · 2 h ago',
    'Source: USGS',
  ]);
  assert.ok(card.position, 'card is anchored on the globe');
});

test('clicking a magnitude tag shows that quake’s card', async () => {
  const h = harness();
  await h.layer.update(h.viewer);
  const labels = h.labels();
  assert.equal(labels.length, 2);
  assert.ok(
    labels.every((label) => label.interactive === true),
    'tags are clickable',
  );
  h.clickLabel('us7000bbbb');
  assert.deepEqual(h.hitTests.at(-1), { sourceId: 'earthquakes' });
  const [card] = h.lastCard();
  assert.equal(card.title, 'QUAKE · M5.3');
  assert.equal(card.details[0], 'off the east coast of Honshu, Japan');
  assert.equal(card.details[1], 'Moderate · 410 km deep · 5 min ago');
  assert.equal(card.accent, '#ffff00');
});

test('clicking empty space closes the card; another layer’s pick does not', async () => {
  const h = harness({ owners: new Set(['flight:abc123']) });
  await h.layer.update(h.viewer);
  h.click(pickQuake('us7000bbbb'));
  assert.equal(h.lastCard().length, 1);
  h.click({ id: { id: 'flight:abc123' } });
  assert.equal(h.lastCard().length, 1, 'aircraft click leaves the card');
  h.click(null);
  assert.deepEqual(h.lastCard(), [], 'empty click closes the card');
});

test('clicks are ignored while another tool owns the pointer', async () => {
  const h = harness();
  await h.layer.update(h.viewer);
  h.setPointerFree(false);
  h.click(pickQuake('us7000aaaa'));
  assert.equal(h.cards().length, 0);
});

test('a selected quake that leaves the feed closes its card on refresh', async () => {
  const h = harness({ snapshots: [rows, [rows[1]]] });
  await h.layer.update(h.viewer);
  h.click(pickQuake('us7000aaaa'));
  assert.equal(h.lastCard().length, 1);
  await h.layer.update(h.viewer);
  assert.deepEqual(h.lastCard(), []);
});

test('disable and destroy remove the click handler and the card', async () => {
  const h = harness();
  await h.layer.update(h.viewer);
  h.click(pickQuake('us7000aaaa'));
  h.layer.disable(h.viewer);
  assert.equal(h.hasHandler, false);
  assert.equal(h.destroyed, 1);
  assert.deepEqual(h.lastCard(), []);
  assert.equal(h.visible.get(EARTHQUAKE_CARD_SOURCE_ID), false);
  h.layer.enable(h.viewer);
  assert.equal(h.hasHandler, true);
  h.layer.destroy(h.viewer);
  assert.equal(h.hasHandler, false);
});

test('without selection wiring the layer behaves as before', async () => {
  const published = [];
  const layer = createEarthquakesLayer({
    source: { getSnapshot: async () => rows },
    overlayHost: {
      setEntries: (sourceId) => published.push(sourceId),
      setVisible() {},
      clearSource() {},
    },
  });
  const viewer = { dataSources: { add() {}, remove() {} } };
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.ok(!published.includes(EARTHQUAKE_CARD_SOURCE_ID));
});

test('card wording helpers', () => {
  assert.equal(magnitudeClass(2.6), 'Weak');
  assert.equal(magnitudeClass(4.0), 'Light');
  assert.equal(magnitudeClass(7.1), 'Major');
  assert.equal(magnitudeClass(Number.NaN), null);
  assert.equal(formatQuakeAge(20000), 'just now');
  assert.equal(formatQuakeAge(12 * 60000), '12 min ago');
  assert.equal(formatQuakeAge(30 * 3600000), '1 d ago');
  assert.equal(formatQuakeAge(-1), null);
  const card = buildEarthquakeCard(
    { stableId: 'x', mag: 3.2, place: null, depthKm: null, time: null },
    NOW,
  );
  assert.deepEqual(card.details, ['Minor', 'Source: USGS']);
  assert.equal(card.accent, '#ff0000');
});
