import { createContext, useContext, useEffect } from "react";
import type { EventFor, EventHandler } from "../events.js";
import type { InteractiveLayer } from "../interactive-layer.js";
import type { FeatureGroup } from "../layer-group.js";
import type { MapEventMap, Orihon } from "../map.js";

export const MapContext = createContext<Orihon | null>(null);
export const LayerContext = createContext<InteractiveLayer | null>(null);
export const GroupContext = createContext<FeatureGroup | null>(null);

export function useMap(): Orihon {
  const map = useContext(MapContext);
  if (!map) throw new Error("useMap() must be used inside <Map>");
  return map;
}

export function useMapEvent<K extends string>(type: K, handler: EventHandler<EventFor<MapEventMap, NoInfer<K>, Orihon>>): Orihon {
  const map = useMap();
  useEffect(() => {
    map.on(type, handler);
    return () => { map.off(type, handler); };
  }, [map, type, handler]);
  return map;
}
