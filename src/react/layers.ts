import { createElement, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LatLngLike } from "../geo.js";
import { FeatureGroup as OrihonFeatureGroup, featureGroup } from "../layer-group.js";
import type { Layer } from "../layer.js";
import { GeoJSONLayer, geoJSON, type GeoJSONData, type GeoJSONOptions } from "../layers/geojson.js";
import { Marker as OrihonMarker, marker, type MarkerOptions } from "../layers/marker.js";
import { TileLayer as OrihonTileLayer, tileLayer, type TileLayerOptions, type TileTemplate } from "../layers/tile-layer.js";
import { GroupContext, LayerContext, useMap } from "./context.js";

function useLayer(layer: Layer): void {
  const map = useMap();
  const group = useContext(GroupContext);
  useLayoutEffect(() => {
    if (group) group.addLayer(layer);
    else layer.addTo(map);
    return () => {
      if (group) group.removeLayer(layer);
      else layer.remove();
    };
  }, [map, group, layer]);
}

export interface TileLayerProps extends TileLayerOptions { url: TileTemplate; }

export function TileLayer({ url, ...options }: TileLayerProps) {
  const [layer] = useState(() => tileLayer(url, options));
  useLayer(layer);
  useLayoutEffect(() => { layer.setUrl(url); }, [layer, url]);
  useLayoutEffect(() => { if (options.opacity != null) layer.setOpacity(options.opacity); }, [layer, options.opacity]);
  return null;
}

export interface MarkerProps extends MarkerOptions {
  position: LatLngLike;
  children?: ReactNode;
}

export function Marker({ position, children, ...options }: MarkerProps) {
  const [layer] = useState(() => marker(position, options));
  useLayer(layer);
  useLayoutEffect(() => { layer.setLatLng(position); }, [layer, position]);
  useLayoutEffect(() => { if (options.opacity != null) layer.setOpacity(options.opacity); }, [layer, options.opacity]);
  return createElement(LayerContext.Provider, { value: layer }, children);
}

export interface GeoJSONProps extends GeoJSONOptions {
  data: GeoJSONData;
}

export function GeoJSON({ data, style, onEachFeature, ...options }: GeoJSONProps) {
  const initial = useRef({ style, onEachFeature, ...options });
  const [layer] = useState(() => geoJSON(data, initial.current));
  useLayer(layer);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    layer.clearLayers().addData(data);
  }, [layer, data]);
  useLayoutEffect(() => { if (style) layer.setStyle(style); }, [layer, style]);
  return createElement(LayerContext.Provider, { value: layer });
}

export interface FeatureGroupProps { children?: ReactNode; }

export function FeatureGroup({ children }: FeatureGroupProps) {
  const [group] = useState<OrihonFeatureGroup>(() => featureGroup());
  useLayer(group);
  return createElement(
    LayerContext.Provider,
    { value: group },
    createElement(GroupContext.Provider, { value: group }, children)
  );
}

export type { OrihonTileLayer, OrihonMarker, GeoJSONLayer };
