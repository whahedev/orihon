import type { RemovedLineStyleAliases, RemovedPointStyleAliases } from "../style-contract.js";

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

export interface ObjectTrailStyle extends RemovedLineStyleAliases {
  enabled?: boolean;
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  maxPoints?: number;
  /** Trail retention in milliseconds. Default 120000; zero disables age trimming. */
  maxAgeMs?: number;
}

export interface ObjectGradientStop {
  offset: number;
  color: string;
}

export interface ObjectLineStyle extends RemovedLineStyleAliases {
  /** Canonical line color, matching PathOptions. */
  stroke?: string;
  /** Canonical line opacity, matching PathOptions. */
  strokeOpacity?: number;
  /** Canonical line width in CSS pixels, matching PathOptions. */
  strokeWidth?: number;
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

export interface ObjectStyle extends RemovedPointStyleAliases {
  /** Point fill color. */
  fill?: string;
  /** Point fill opacity from 0 to 1. */
  fillOpacity?: number;
  size?: number;
  icon?: string | null;
  /** Explicit icon tint; when omitted, `fill` is used for tintable icons. */
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
