export type ObjectId = string | number;

export type ObjectStateValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export interface ObjectState {
  selected?: boolean;
  hovered?: boolean;
  [key: string]: ObjectStateValue;
}

export interface ObjectLabelStyle {
  text: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  color?: string;
  haloColor?: string;
  haloWidth?: number;
  offset?: readonly [number, number];
  priority?: number;
  minZoom?: number;
  maxZoom?: number;
}

export interface ObjectTrailStyle {
  enabled?: boolean;
  color?: string;
  width?: number;
  opacity?: number;
  maxPoints?: number;
  maxAge?: number;
}

export interface ObjectGradientStop {
  offset: number;
  color: string;
}

export interface ObjectLineStyle {
  /** Canonical line color, matching PathOptions. */
  stroke?: string;
  /** Canonical line opacity, matching PathOptions. */
  strokeOpacity?: number;
  /** Canonical line width in CSS pixels, matching PathOptions. */
  strokeWidth?: number;
  /** @deprecated Compatibility alias for `stroke`. */
  color?: string;
  /** @deprecated Compatibility alias for `strokeOpacity`. */
  opacity?: number;
  /** @deprecated Compatibility alias for `strokeWidth`. */
  width?: number;
  dashArray?: readonly number[];
  dashOffset?: number;
  gradient?: readonly ObjectGradientStop[];
}

export interface ObjectPolygonStyle {
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
}

export type ObjectCollisionMode = "auto" | "always" | "hide";

export interface ObjectStyle {
  /** Canonical point fill color. Takes precedence over `color`. */
  fill?: string;
  /** Canonical point fill opacity from 0 to 1. Takes precedence over `opacity`. */
  fillOpacity?: number;
  /** Compatibility alias for `fill`. */
  color?: string;
  /** Compatibility alias for `fillOpacity`. */
  opacity?: number;
  size?: number;
  icon?: string | null;
  /** Explicit icon tint; when omitted, `fill` (or legacy `color`) is used for tintable icons. */
  iconTint?: string;
  /** Degrees: 0 up, 90 right, 180 down, 270 left. */
  rotation?: number;
  rotationAlignment?: "screen" | "map";
  label?: string | ObjectLabelStyle | null;
  visible?: boolean;
  collisionMode?: ObjectCollisionMode;
  trail?: ObjectTrailStyle | null;
  line?: ObjectLineStyle;
  polygon?: ObjectPolygonStyle;
}

export interface ObjectStyleContext {
  id: ObjectId;
  zoom: number;
  renderer: "dom" | "webgl";
  selected: boolean;
  hovered: boolean;
  visualization: "objects" | "clusters" | "heatmap";
}

export type ObjectStyleResolver = (
  object: { id?: ObjectId; properties?: Record<string, unknown>; [key: string]: unknown },
  state: Readonly<ObjectState>,
  context: Readonly<ObjectStyleContext>
) => ObjectStyle | null | undefined;

export const ObjectDirtyFlags = {
  None: 0,
  Position: 1 << 0,
  Geometry: 1 << 1,
  Style: 1 << 2,
  State: 1 << 3,
  Visibility: 1 << 4,
  SearchIndex: 1 << 5,
  TimeIndex: 1 << 6,
  Trail: 1 << 7
} as const;

export type ObjectDirtyFlag = (typeof ObjectDirtyFlags)[keyof typeof ObjectDirtyFlags];
