#!/usr/bin/env node
// Mock opencode CLI for unit tests: NDJSON events on stdout, prompt on stdin.
if (process.env.MOCK_OC_HANG) {
  setTimeout(() => {}, 60000);
} else if (process.env.MOCK_OC_ERROR) {
  process.stdout.write(
    JSON.stringify({ type: "error", sessionID: "ses-test-123", error: { type: "provider.no-route", message: "Model unavailable" } }) + "\n",
  );
  process.exit(0);
} else {
  process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "ses-test-123", part: { type: "step-start" } }) + "\n");
  process.stdout.write(
    JSON.stringify({ type: "text", sessionID: "ses-test-123", part: { type: "text", text: "Done!" } }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses-test-123",
      part: { type: "step-finish", reason: "stop", tokens: { input: 10, output: 5 } },
    }) + "\n",
  );
  process.exit(0);
}
