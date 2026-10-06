// Weight presets: heavy / medium / light resolve to concrete
// {leadModel, workerModel, effort} per backend. Explicit --lead-model,
// --worker-model and --effort flags always win over the preset; applying a
// preset (config.set preset, `/model heavy`) resets those knobs to the
// preset values.
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { BackendName } from "./protocol.js";

export type PresetName = "heavy" | "medium" | "light";

export interface Preset {
  leadModel: string;
  workerModel: string;
  effort: EffortLevel;
}

export const PRESETS: PresetName[] = ["heavy", "medium", "light"];

export function isPreset(v: unknown): v is PresetName {
  return typeof v === "string" && (PRESETS as string[]).includes(v.toLowerCase());
}

const TABLE: Record<BackendName, Record<PresetName, Preset>> = {
  sim: {
    heavy: { leadModel: "sim", workerModel: "sim", effort: "high" },
    medium: { leadModel: "sim", workerModel: "sim", effort: "medium" },
    light: { leadModel: "sim", workerModel: "sim", effort: "low" },
  },
  claude: {
    heavy: { leadModel: "opus", workerModel: "opus", effort: "high" },
    medium: { leadModel: "opus", workerModel: "sonnet", effort: "medium" },
    light: { leadModel: "sonnet", workerModel: "sonnet", effort: "low" },
  },
  antigravity: {
    heavy: { leadModel: "gemini-3.8-flash-high", workerModel: "gemini-3.8-flash-high", effort: "high" },
    medium: { leadModel: "gemini-3.8-flash-high", workerModel: "gemini-3.8-flash-low", effort: "medium" },
    light: { leadModel: "gemini-3.8-flash-low", workerModel: "gemini-3.8-flash-low", effort: "low" },
  },
  opencode: {
    heavy: { leadModel: "opencode/claude-opus-5-5", workerModel: "opencode/claude-sonnet-5-5", effort: "high" },
    medium: { leadModel: "opencode/muse-spark-1.3", workerModel: "opencode/muse-spark-1.3", effort: "medium" },
    light: { leadModel: "opencode/space-bunny-free", workerModel: "opencode/space-bunny-free", effort: "low" },
  },
};

export function resolvePreset(backend: BackendName, preset: PresetName): Preset {
  return TABLE[backend][preset];
}

/** opencode has no --effort flag: effort selects the model #variant (medium = no suffix). */
export function ocModelWithEffort(model: string, eff: EffortLevel | undefined): string {
  if (model.includes("#")) return model;
  switch (eff) {
    case "low":
      return `${model}#low`;
    case "high":
    case "xhigh":
      return `${model}#high`;
    case "max":
      return `${model}#max`;
    default:
      return model;
  }
}

export interface ModelInfo {
  name: string;
  detail: string;
}

/** Curated pickable models per backend (opencode additionally lists live via `opencode models`). */
export const KNOWN_MODELS: Record<BackendName, ModelInfo[]> = {
  sim: [{ name: "sim", detail: "scripted demo team, no API calls" }],
  claude: [
    { name: "opus", detail: "heaviest Claude reasoning; lead default" },
    { name: "sonnet", detail: "balanced Claude; worker default" },
  ],
  antigravity: [
    { name: "gemini-3.8-flash-high", detail: "heaviest agy flash; lead default" },
    { name: "gemini-3.8-flash-low", detail: "fast agy flash; worker default" },
  ],
  opencode: [
    { name: "opencode/claude-opus-5-5", detail: "heavy preset lead" },
    { name: "opencode/claude-sonnet-5-5", detail: "heavy preset worker" },
    { name: "opencode/muse-spark-1.3", detail: "medium preset; balanced default" },
    { name: "opencode/gpt-5.5", detail: "strong general model" },
    { name: "opencode/gpt-5.4-mini", detail: "fast inexpensive model" },
    { name: "opencode/space-bunny-free", detail: "light preset; free tier" },
  ],
};
