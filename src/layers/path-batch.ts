import {
  WebGLPathBatch,
  type WebGLPathBatchOptions
} from "./webgl-path-batch.js";
import {
  WebGLStyledPathBatch,
  type WebGLStyledPathBatchOptions
} from "./webgl-styled-path-batch.js";

export type PathBatchMode = "uniform" | "feature";

export type UniformPathBatchOptions = WebGLPathBatchOptions & {
  mode?: "uniform";
};

export type FeaturePathBatchOptions = WebGLStyledPathBatchOptions & {
  mode: "feature";
};

export type PathBatchOptions = UniformPathBatchOptions | FeaturePathBatchOptions;
export type PathBatch = WebGLPathBatch | WebGLStyledPathBatch;

/**
 * Create one high-volume path layer. Uniform paths use the fast WebGL pipeline;
 * feature mode preserves per-path colors, widths, dashes, gradients and picking.
 */
export function pathBatch(options?: UniformPathBatchOptions): WebGLPathBatch;
export function pathBatch(options: FeaturePathBatchOptions): WebGLStyledPathBatch;
export function pathBatch(options: PathBatchOptions = {}): PathBatch {
  if (options.mode === "feature") {
    const { mode: _mode, ...styledOptions } = options;
    return new WebGLStyledPathBatch(styledOptions);
  }
  const { mode: _mode, ...uniformOptions } = options;
  return new WebGLPathBatch(uniformOptions);
}
