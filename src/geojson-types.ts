/** Neutral GeoJSON domain types shared by FeatureSource, layers and services. */

export type GeoJSONPosition = [number, number, ...number[]];

export interface GeoJSONPointGeometry {
  type: "Point";
  coordinates: GeoJSONPosition;
}

export interface GeoJSONMultiPointGeometry {
  type: "MultiPoint";
  coordinates: GeoJSONPosition[];
}

export interface GeoJSONLineStringGeometry {
  type: "LineString";
  coordinates: GeoJSONPosition[];
}

export interface GeoJSONMultiLineStringGeometry {
  type: "MultiLineString";
  coordinates: GeoJSONPosition[][];
}

export interface GeoJSONPolygonGeometry {
  type: "Polygon";
  coordinates: GeoJSONPosition[][];
}

export interface GeoJSONMultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: GeoJSONPosition[][][];
}

export interface GeoJSONGeometryCollection {
  type: "GeometryCollection";
  geometries: GeoJSONGeometry[];
}

export type GeoJSONGeometry =
  | GeoJSONPointGeometry
  | GeoJSONMultiPointGeometry
  | GeoJSONLineStringGeometry
  | GeoJSONMultiLineStringGeometry
  | GeoJSONPolygonGeometry
  | GeoJSONMultiPolygonGeometry
  | GeoJSONGeometryCollection;

export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometry | null;
  properties?: Record<string, unknown> | null;
  id?: string | number;
  bbox?: number[];
}

/** GeoJSON Feature with a required canonical id (FeatureSource mutation contract). */
export type IdentifiedGeoJSONFeature = GeoJSONFeature & { id: string | number };

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
  bbox?: number[];
}
