import { describe, expect, it } from "vitest";
import { toolActivity } from "../src/agents/activity.js";

describe("toolActivity mapping", () => {
  it("maps antigravity inspection tools to library / reading", () => {
    const read = toolActivity("view_file", { absolute_path: "/repo/src/index.ts" }, "/repo");
    expect(read.state).toBe("reading");
    expect(read.station).toBe("library");
    expect(read.label).toBe("Read src/index.ts");

    const grep = toolActivity("grep_search", { Query: "function main", SearchPath: "/repo" });
    expect(grep.state).toBe("reading");
    expect(grep.station).toBe("library");
    expect(grep.activity).toContain("function main");

    const find = toolActivity("find_by_name", { Pattern: "*.ts" });
    expect(find.state).toBe("reading");
    expect(find.station).toBe("library");

    const list = toolActivity("list_dir", { DirectoryPath: "/repo/src" });
    expect(list.state).toBe("reading");
    expect(list.station).toBe("library");
  });

  it("maps antigravity editing tools to desk / editing", () => {
    const edit = toolActivity("replace_file_content", { target_file: "/repo/src/index.ts" }, "/repo");
    expect(edit.state).toBe("editing");
    expect(edit.station).toBe("desk");
    expect(edit.label).toBe("Edit src/index.ts");

    const write = toolActivity("write_to_file", { target_file: "/repo/README.md" }, "/repo");
    expect(write.state).toBe("editing");
    expect(write.station).toBe("desk");
    expect(write.label).toBe("Write README.md");
  });

  it("maps run_command to testbench when testing and terminal when running", () => {
    const test = toolActivity("run_command", { CommandLine: "npm test" });
    expect(test.state).toBe("testing");
    expect(test.station).toBe("testbench");

    const vitest = toolActivity("run_command", { CommandLine: "npx vitest run test/app.test.ts" });
    expect(vitest.state).toBe("testing");
    expect(vitest.station).toBe("testbench");

    const build = toolActivity("run_command", { CommandLine: "npm run build" });
    expect(build.state).toBe("running");
    expect(build.station).toBe("terminal");
  });
});
