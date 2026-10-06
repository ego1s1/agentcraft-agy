import { describe, expect, it } from "vitest";
import { isPreset, KNOWN_MODELS, ocModelWithEffort, PRESETS, resolvePreset } from "../src/presets.js";

describe("presets", () => {
  it("recognizes heavy|medium|light case-insensitively", () => {
    expect(isPreset("heavy")).toBe(true);
    expect(isPreset("Medium")).toBe(true);
    expect(isPreset("LIGHT")).toBe(true);
    expect(isPreset("xl")).toBe(false);
    expect(isPreset(undefined)).toBe(false);
    expect(PRESETS).toEqual(["heavy", "medium", "light"]);
  });

  it("resolves a full knob set per backend", () => {
    for (const backend of ["sim", "claude", "antigravity", "opencode"] as const) {
      for (const preset of PRESETS) {
        const p = resolvePreset(backend, preset);
        expect(p.leadModel).toBeTruthy();
        expect(p.workerModel).toBeTruthy();
        expect(["low", "medium", "high", "xhigh", "max"]).toContain(p.effort);
      }
    }
    expect(resolvePreset("opencode", "medium")).toMatchObject({
      leadModel: "opencode-go/muse-spark-1.3-contributor",
      effort: "medium",
    });
    expect(resolvePreset("antigravity", "medium").workerModel).toBe("gemini-3.8-flash-low");
    expect(resolvePreset("claude", "heavy").leadModel).toBe("opus");
  });

  it("maps effort to opencode model variants", () => {
    expect(ocModelWithEffort("opencode/gpt-5.5", "low")).toBe("opencode/gpt-5.5#low");
    expect(ocModelWithEffort("opencode/gpt-5.5", "medium")).toBe("opencode/gpt-5.5");
    expect(ocModelWithEffort("opencode/gpt-5.5", "high")).toBe("opencode/gpt-5.5#high");
    expect(ocModelWithEffort("opencode/gpt-5.5", "xhigh")).toBe("opencode/gpt-5.5#high");
    expect(ocModelWithEffort("opencode/gpt-5.5", "max")).toBe("opencode/gpt-5.5#max");
    expect(ocModelWithEffort("opencode/gpt-5.5", undefined)).toBe("opencode/gpt-5.5");
    // Explicit #variant in the model name always wins.
    expect(ocModelWithEffort("opencode/gpt-5.5#low", "max")).toBe("opencode/gpt-5.5#low");
  });

  it("curates pickable models per backend", () => {
    expect(KNOWN_MODELS.opencode.length).toBeGreaterThan(3);
    expect(KNOWN_MODELS.opencode.map((m) => m.name)).toContain("opencode/space-bunny-free");
  });
});
