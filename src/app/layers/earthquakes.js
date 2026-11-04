import * as Cesium from 'cesium';
import { createEarthquakesLayer } from '../../layers/earthquakes/index.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import { overlayHost } from './overlayHost.js';
/** Wire earthquake observations and click selection to the application. */
export function createApplicationEarthquakes(options) {
  return createEarthquakesLayer({
    overlayHost: { ...overlayHost, hitTest: hitTestWorldOverlay },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
