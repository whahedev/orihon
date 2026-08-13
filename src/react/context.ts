import { createContext, useContext, useEffect } from "react";
import type { OrihonEvent, EventHandler } from "../events.js";
import type { Layer } from "../layer.js";
import type { FeatureGroup } from "../layer-group.js";
import type { Orihon } from "../map.js";

export const MapContext = createContext<Orihon | null>(null);
export const LayerContext = createContext<Layer | null>(null);
export const GroupContext = createContext<FeatureGroup | null>(null);

export function useMap(): Orihon {
  const map = useContext(MapContext);
  if (!map) throw new Error("useMap() must be used inside <Map>");
  return map;
}

export function useMapEvent<T extends OrihonEvent = OrihonEvent>(type: string, handler: EventHandler<T>): Orihon {
  const map = useMap();
  useEffect(() => {
    map.on(type, handler);
    return () => { map.off(type, handler as EventHandler); };
  }, [map, type, handler]);
  return map;
}
