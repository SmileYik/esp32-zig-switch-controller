import { generateZigMacroScriptDFS } from "./algorithmDFS";
import { generateZigMacroScriptFill } from "./algorithmFill";
import { generateZigMacroScriptLayerFill } from "./algorithmLayerFill";
import { generateZigMacroScriptBySegment } from "./algorithmSegment";
import type { MacroGenerator } from "./common";

export type MacroAlgorithmType = "segment" | "dfs" | "fill" | "layer-fill";
export interface MacroAlgorithm {
  type: MacroAlgorithmType,
  generator: MacroGenerator,
};
export const MacroAlgorithmMap: Record<MacroAlgorithmType, MacroAlgorithm> = {
  "dfs": { type: "dfs", generator: generateZigMacroScriptDFS },
  "segment": { type: "segment", generator: generateZigMacroScriptBySegment },
  "fill": { type: "fill", generator: generateZigMacroScriptFill },
  "layer-fill": { type: "layer-fill", generator: generateZigMacroScriptLayerFill },
};