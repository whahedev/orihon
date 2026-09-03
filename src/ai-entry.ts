export { AIError } from "./ai/errors.js";
export { AICommandEngine, cameraFromPositions, createAICommandEngine } from "./ai/engine.js";
export { AICapabilityRegistry, createDefaultAICapabilityRegistry } from "./ai/capabilities.js";
export { AIAgentRuntime, compactAIPlan, createAIAgentRuntime, validateAIIntent } from "./ai/runtime.js";
export { createAILLMAgent } from "./ai/agent.js";
export { createOpenAICompatibleAdapter } from "./ai/openai-compatible.js";
export {
  ORIHON_AI_AGENT_SYSTEM_PROMPT,
  createAIPlaceSearchTool,
  createNominatimPlaceSearchProvider,
  executeAIPlaceSearch
} from "./ai/place-search.js";
export {
  AI_INTENT_SCHEMA,
  AI_INTENT_SCHEMA_FULL,
  AI_INTENT_SCHEMA_STRESS,
  AI_INTENT_SCHEMA_VISIT,
  AI_INTENT_SCHEMAS,
  ORIHON_AI_INTENT_SYSTEM_PROMPT,
  createAIIntentTool,
  getAIIntentSchema
} from "./ai/semantic-tool.js";
export { createAIHTTPHandler } from "./ai/http.js";
export { AIMapProjection, createAIMapProjection } from "./ai/projection.js";
export { AISession, applyScene, createAISession } from "./ai/session.js";
export {
  AI_COMMAND_SCHEMA,
  AI_ENGINE_COMMAND_SCHEMA,
  AI_ENGINE_COMMAND_SCHEMAS,
  ORIHON_AI_ENGINE_SYSTEM_PROMPT,
  ORIHON_AI_POINTS_SYSTEM_PROMPT,
  ORIHON_AI_SYSTEM_PROMPT,
  createAIEngineTool,
  createAITool,
  getAIEngineCommandSchema,
  getAIEngineSystemPrompt
} from "./ai/tool.js";
export {
  validateEngineCommand,
  validateObjectCommand,
  validatePointPatches,
  validatePointsReplaceCommand,
  validateRoutePlanCommand
} from "./ai/engine-validation.js";
export { validateCommand, validateLayer, validateLayerDescription, validateScene } from "./ai/validation.js";
export type {
  AIBasemapSpec,
  AIAgentContext,
  AICapabilityDescription,
  AICapabilityOperationDescription,
  AICreateVisitRouteIntent,
  AICameraSpec,
  AICommand,
  AICommandSuccess,
  AICollectionCommand,
  AIEngineCommand,
  AIEngineCommandSuccess,
  AIEngineEvent,
  AIEngineExecuteOptions,
  AIEngineSnapshot,
  AIEngineTransactionEvent,
  AIEngineTransactionOptions,
  AIEngineTransactionPreview,
  AIEngineTransactionSuccess,
  AIEngineToolSuccess,
  AIErrorCode,
  AIErrorDetails,
  AIGeoJSONLayer,
  AILayerDescription,
  AILayerSpec,
  AIMarkerAppearance,
  AIMarkerLayer,
  AIIntent,
  AIIntentCommitSuccess,
  AIObjectBatchChange,
  AIObjectCommand,
  AIObjectFeature,
  AIPopupImage,
  AIPointCategory,
  AIPointDefaults,
  AIPointPatch,
  AIPointPopup,
  AIPointSpec,
  AIPointVisual,
  AIPointVisualDefaults,
  AIPointVisualImage,
  AIPointVisualLabel,
  AIPointsReplaceCommand,
  AIPointViewport,
  AIRichPointPopup,
  AIPathStyle,
  AIPlan,
  AIPlanExecution,
  AIPlanStep,
  AIPolygonLayer,
  AIPolylineLayer,
  AIPosition,
  AIRasterLayer,
  AIRouteCommand,
  AIRoutePlanCommand,
  AIRoutePlanState,
  AIRouteResult,
  AIRouteSummary,
  AIResourceReference,
  AIResult,
  AISceneSpec,
  AITextContent,
  AIUpdatePointsIntent,
  AIVisualizationStressIntent,
  AIVisualizationStressUpdateIntent
} from "./ai/types.js";
export type { AICommandEngineInitialState, AIEngineListener } from "./ai/engine.js";
export type { AICapabilityAdapter } from "./ai/capabilities.js";
export type { AIPlanPreviewResult } from "./ai/runtime.js";
export type {
  AILLMAdapter,
  AILLMAgent,
  AILLMAgentOptions,
  AILLMAgentSuccess,
  AILLMAgentToolTrace,
  AILLMCompletion,
  AILLMCompletionRequest,
  AILLMExecutableTool,
  AILLMMessage,
  AILLMToolCall,
  AILLMToolDefinition,
  AILLMUsage
} from "./ai/agent.js";
export type { OpenAICompatibleAdapterOptions } from "./ai/openai-compatible.js";
export type {
  AIPlaceSearchCandidate,
  AIPlaceSearchImage,
  AIPlaceSearchProfile,
  AIPlaceSearchProvider,
  AIPlaceSearchRequest,
  AIPlaceSearchResultMode,
  AIPlaceSearchSuccess,
  NominatimPlaceSearchOptions
} from "./ai/place-search.js";
export type {
  AIIntentSchemaProfile,
  AIIntentToolBridge,
  AIIntentToolOptions,
  AIIntentToolSuccess
} from "./ai/semantic-tool.js";
export type { AIHTTPHandler, AIHTTPHandlerOptions } from "./ai/http.js";
export type { AIMapProjectionOptions, AIProjectionSuccess } from "./ai/projection.js";
export type {
  AIEngineSchemaProfile,
  AIEngineToolBridge,
  AIEngineToolOptions,
  AIJSONSchema,
  AIToolBridge,
  AIToolDefinition,
  AIToolOptions
} from "./ai/tool.js";
