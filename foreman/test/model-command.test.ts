import { describe, expect, it } from "vitest";
import { Foreman } from "../src/foreman.js";
import { silentLogger } from "../src/context.js";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";

function testForeman(backend: "antigravity" | "claude" = "antigravity") {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ac-model-test-"));
  return new Foreman({
    config: {
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
      antigravity: {
        agyBin: "agy",
        effort: "medium",
      },
      claude: {
        effort: "medium",
      },
    } as any,
    logger: silentLogger,
  });
}

describe("Dynamic model & effort configuration", () => {
  it("handles config.set to change effort and model", async () => {
    const fm = testForeman("antigravity");
    expect(fm.status.effort).toBe("medium");

    // Change effort to high
    const res1 = await (fm as any).dispatch(
      { v: 1, id: "m1", type: "config.set", effort: "high" },
      () => {}
    );
    expect(res1.ok).toBe(true);
    expect(res1.effort).toBe("high");
    expect(fm.status.effort).toBe("high");

    // Change effort with alias med -> medium
    const res2 = await (fm as any).dispatch(
      { v: 1, id: "m2", type: "config.set", effort: "med" },
      () => {}
    );
    expect(res2.ok).toBe(true);
    expect(res2.effort).toBe("medium");
    expect(fm.status.effort).toBe("medium");

    // Set model
    const res3 = await (fm as any).dispatch(
      { v: 1, id: "m3", type: "config.set", model: "gemini-2.5-flash" },
      () => {}
    );
    expect(res3.ok).toBe(true);
    expect(res3.model).toBe("gemini-2.5-flash");
    expect(fm.status.model).toBe("gemini-2.5-flash");
  });

  it("handles chat user.message with /model", async () => {
    const fm = testForeman("antigravity");

    // Query status
    const res1 = await (fm as any).dispatch(
      { v: 1, id: "u1", type: "user.message", to: "all", text: "/model" },
      () => {}
    );
    expect(res1.ok).toBe(true);
    expect(res1.effort).toBe("medium");

    // Set to low
    const res2 = await (fm as any).dispatch(
      { v: 1, id: "u2", type: "user.message", to: "all", text: "/model low" },
      () => {}
    );
    expect(res2.ok).toBe(true);
    expect(res2.effort).toBe("low");
    expect(fm.status.effort).toBe("low");

    // Set to high
    const res3 = await (fm as any).dispatch(
      { v: 1, id: "u3", type: "user.message", to: "all", text: "/model high" },
      () => {}
    );
    expect(res3.ok).toBe(true);
    expect(res3.effort).toBe("high");
    expect(fm.status.effort).toBe("high");
  });
});
