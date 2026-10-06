#!/usr/bin/env node
// Mock agy CLI for unit tests
if (process.env.MOCK_AGY_HANG) {
  setTimeout(() => {}, 60000);
} else {
  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'test-conv-123' }) + '\n');
  process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'test-conv-123', status: 'SUCCESS', response: 'Done!' } }) + '\n');
  process.exit(0);
}
