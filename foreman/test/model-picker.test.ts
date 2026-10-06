import { describe, expect, it } from "vitest";
import { Foreman } from "../src/foreman.js";
import { silentLogger } from "../src/context.js";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";

function testForeman(backend: "antigravity" | "claude" | "opencode" = "opencode") {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ac-picker-test-"));
  const base: any = {
    backend,
    dataDir: dir,
    projectRoot: process.cwd(),
    port: 0,
    debug: false,
    quiet: true,
    userName: "Alex",
    notify: false,
    toastSilent: true,
    mergeStyle: "merge",
    signMerges: false,
  };
  base[backend] =
    backend === "opencode"
      ? { ocBin: "opencode", leadModel: "opencode/muse-spark-1.3", workerModel: "opencode/muse-spark-1.3", effort: "medium" }
      : backend === "antigravity"
        ? { agyBin: "agy", effort: "medium" }
        : { effort: "medium" };
  return new Foreman({ config: base, logger: silentLogger });
}

async function model(fm: Foreman, text: string) {
  return (fm as any).dispatch({ v: 1, id: `m-${Math.random()}`, type: "user.message", to: "all", text }, () => {});
}

describe("/model picker", () => {
  it("shows a status card on bare /model", async () => {
    const fm = testForeman("opencode");
    const res = await model(fm, "/model");
    expect(res.ok).toBe(true);
    expect(res.text).toMatch(/Backend: opencode/);
    expect(res.text).toMatch(/Lead: opencode\/muse-spark-1.3/);
    expect(res.text).toMatch(/\/model list/);
  });

  it("applies presets and resets knobs", async () => {
    const fm = testForeman("opencode");
    const res = await model(fm, "/model heavy");
    expect(res.preset).toBe("heavy");
    expect(res.text).toMatch(/Preset: heavy/);
    expect(fm.status.preset).toBe("heavy");

    // Explicit change clears the preset marker.
    const res2 = await model(fm, "/model low");
    expect(res2.effort).toBe("low");
    expect(fm.status.preset).toBeUndefined();
    expect((fm as any).config.opencode.preset).toBeUndefined();
  });

  it("lists models and picks by number", async () => {
    const fm = testForeman("antigravity");
    const list = await model(fm, "/model list");
    expect(list.text).toMatch(/1\. gemini-3.8-flash-high/);

    const pick = await model(fm, "/model 2");
    expect(pick.model).toBe("gemini-3.8-flash-low");
    expect(fm.status.model).toBe("gemini-3.8-flash-low");
  });

  it("sets lead/worker models separately", async () => {
    const fm = testForeman("opencode");
    await model(fm, "/model lead opencode/gpt-5.5-pro");
    expect((fm as any).config.opencode.leadModel).toBe("opencode/gpt-5.5-pro");
    expect((fm as any).config.opencode.workerModel).toBe("opencode/muse-spark-1.3");

    await model(fm, "/model worker opencode/gpt-5.4-mini");
    expect((fm as any).config.opencode.workerModel).toBe("opencode/gpt-5.4-mini");
  });

  it("explains a model with details", async () => {
    const fm = testForeman("opencode");
    (fm as any).modelList = () => [
      { name: "opencode/muse-spark-1.3", detail: "balanced default", live: false },
    ];
    const res = await model(fm, "/model details spark");
    expect(res.text).toMatch(/opencode\/muse-spark-1.3/);
    expect(res.text).toMatch(/Preset: medium/);

    const missing = await model(fm, "/model details nope-not-real");
    expect(missing.text).toMatch(/Usage: \/model details/);
  });

  it("config.set preset resets knobs", async () => {
    const fm = testForeman("claude");
    const res = await (fm as any).dispatch({ v: 1, id: "p1", type: "config.set", preset: "light" }, () => {});
    expect(res.ok).toBe(true);
    expect(res.preset).toBe("light");
    expect((fm as any).config.claude.leadModel).toBe("sonnet");
    expect((fm as any).config.claude.effort).toBe("low");
    expect(fm.status.preset).toBe("light");
  });
});
