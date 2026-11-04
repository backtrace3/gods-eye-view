import * as Cesium from 'cesium';
import {
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  depthColor,
  createEarthquakeOverlayEntry,
  selectEarthquakeOverlayCohort,
  mapAnalystRecord,
} from './model.js';
import { EARTHQUAKE_CARD_SOURCE_ID, buildEarthquakeCard } from './cards.js';
export * from './model.js';
export * from './cards.js';
export { createUsgsEarthquakeSource } from './source.js';

// A portable package (no i18n): the error stays English data and the layer
// panel shows it translated.
const msg = (text) => text;

const PICK_PREFIX = 'earthquake:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/**
 * Own one earthquake display, its refresh lifecycle, and click selection.
 * Selection is optional: it turns on only when the caller supplies a
 * screen-space handler factory and the pick registry (the application does).
 */
export function createEarthquakesLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Earthquakes require a snapshot source');
  if (!overlayHost) throw new TypeError('Earthquakes require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  /** @type {Map<string, Object>} Latest rows by stable id, for the card. */
  const _rowById = new Map();

  const canSelect = () => Boolean(screenSpaceEventHandlerFactory && picking);

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(EARTHQUAKE_CARD_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = {
      ...buildEarthquakeCard(row, now()),
      position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
    };
    overlayHost.setEntries(
      EARTHQUAKE_CARD_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to one of this layer's earthquake ids, or null. */
  function pickedQuakeId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _rowById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer?.scene?.canvas) return;
    // Not registered as a pick owner, for the same reason as fire
    // perimeters: these are ground discs, and claiming them would make
    // sibling layers' cards inert anywhere over a quake.
    try {
      _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    } catch (e) {
      // Selection is a convenience: without a usable canvas (headless
      // harnesses) the layer still draws, it just can't be clicked.
      console.warn('[Data:Earthquakes] Click selection unavailable:', e);
      _clickHandler = null;
      return;
    }
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      // The "M4.6" tags are the big targets at most zoom levels (the discs
      // shrink to a few pixels), so a click on a tag selects its quake first.
      const labelHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: EARTHQUAKE_OVERLAY_SOURCE_ID },
      );
      if (labelHit && _rowById.has(String(labelHit.entryId))) {
        _selectedId = String(labelHit.entryId);
        publishSelectedCard();
        return;
      }
      const picked = _viewer?.scene?.pick(click.position);
      const quakeId = picked ? pickedQuakeId(picked) : null;
      if (quakeId) {
        _selectedId = quakeId;
        publishSelectedCard();
        return;
      }
      // A pick that belongs to another layer (an aircraft, a camera) is not
      // empty space: leave the selection alone and let that layer handle it.
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  function clearSelection() {
    _selectedId = null;
    if (!canSelect()) return;
    overlayHost.clearSource(EARTHQUAKE_CARD_SOURCE_ID);
    overlayHost.setVisible(EARTHQUAKE_CARD_SOURCE_ID, false);
  }

  const layer = {
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Earthquake layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('earthquakes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Earthquakes] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // No continuous-render hold: the discs are static geometry now, so the
      // layer has no per-frame animator to keep the render loop alive for.
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
      if (canSelect()) {
        overlayHost.setVisible(EARTHQUAKE_CARD_SOURCE_ID, true);
        installClickHandler();
      }
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];
        _rowById.clear();
        for (const row of rows) _rowById.set(String(row.stableId), row);

        for (const {
          stableId,
          usgsId,
          lon,
          lat,
          depthKm,
          mag,
          place,
          time,
        } of rows) {
          count++;
          const baseRadius = Math.pow(2, mag) * 1000;
          const color = depthColor(depthKm || 0);
          const isSignificant = mag >= 5.0;
          const fillAlpha = isSignificant ? 0.4 : 0.3;
          const outlineAlpha = isSignificant ? 1.0 : 0.8;

          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `earthquake:${stableId}`,
              position,
              ellipse: {
                // Static axes — see the module header. A CallbackProperty here
                // re-tessellates the clamped ground geometry every frame.
                semiMajorAxis: baseRadius,
                semiMinorAxis: baseRadius,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(fillAlpha),
                ),
                outline: true,
                outlineColor: color.withAlpha(outlineAlpha),
                outlineWidth: isSignificant ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                // Analyst seam (additive): the USGS event id (e.g. "us7000abcd").
                usgsId,
                mag,
                place,
                time,
                depth: depthKm,
              },
            }),
          );
          const label = createEarthquakeOverlayEntry({
            id: String(stableId),
            position,
            magnitude: mag,
            accent: color.toCssColorString(),
          });
          // Only the overlay's interactive entries get click rectangles.
          if (canSelect() && overlayHost.hitTest) label.interactive = true;
          overlayEntries.push(label);
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            EARTHQUAKE_OVERLAY_SOURCE_ID,
            selectEarthquakeOverlayCohort(overlayEntries),
            {
              cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
              collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        // Refresh an open card (its "x min ago" ages), or close it if the
        // selected quake fell out of the 24-hour feed.
        if (_selectedId) publishSelectedCard();
        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Earthquakes] Updated: ${_count} events (M2.5+)`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Earthquakes] Fetch error:', e);
        _lastError = e?.message || msg('Earthquake source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _viewer = null;
      _enabled = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's in-memory earthquake records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              id: p?.usgsId?.getValue(now) ?? null,
              mag: p?.mag?.getValue(now),
              place: p?.place?.getValue(now),
              time: p?.time?.getValue(now),
              depth: p?.depth?.getValue(now),
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
            },
            result.length,
          ),
        );
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
