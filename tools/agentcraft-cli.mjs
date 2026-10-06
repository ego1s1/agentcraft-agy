#!/usr/bin/env node
// CLI bridge for AgentCraft agents running in subshells or Antigravity turns.
// Usage: agentcraft <subcommand> [--flag value ...]
// Example: agentcraft update-task --task-id AC-1 --status review --summary "done"

import http from 'node:http';

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
  console.log(`AgentCraft CLI tool bridge
Usage: agentcraft <command> [options]

Commands:
  create-task     --title <title> --description <desc> [--assignee <id>] [--deps <id1,id2>]
  update-task     --task-id <id> [--status <status>] [--summary <summary>] [--blocked-reason <reason>]
  report-status   --activity <activity> [--note <note>]
  list-tasks      [--goal-id <id>]
  request-merge   --task-id <id> --summary <summary>
  ask-user        --question <question> [--options <opt1,opt2>] [--context <context>]
  send-message    --to <agent|lead|all|user> --text <message>
  write-memory    --title <title> --body <markdown> [--scope <shared|private>] [--mode <replace|append>]
  read-memory     [--id <id>] [--query <search>]
`);
  process.exit(0);
}

const rawCmd = argv[0].replace(/-/g, '_');
const args = {};

for (let i = 1; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith('--')) {
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      if (key === 'options' || key === 'deps') {
        args[key] = next.split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        args[key] = next;
      }
      i++;
    } else {
      args[key] = true;
    }
  }
}

const port = process.env.AGENTCRAFT_PORT || '7878';
const agentId = process.env.AGENTCRAFT_AGENT_ID || 'marlow';

const postData = JSON.stringify({
  agentId,
  tool: rawCmd,
  args,
});

const req = http.request(
  {
    hostname: '127.0.0.1',
    port: parseInt(port, 10),
    path: '/api/tool',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      Host: `127.0.0.1:${port}`,
    },
  },
  (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (json.text) {
          console.log(json.text);
        } else if (json.error) {
          console.error(`Error: ${json.error}`);
        } else {
          console.log(body);
        }
        process.exit(res.statusCode && res.statusCode >= 400 ? 1 : 0);
      } catch {
        console.log(body);
        process.exit(res.statusCode && res.statusCode >= 400 ? 1 : 0);
      }
    });
  },
);

req.on('error', (e) => {
  console.error(`Error contacting AgentCraft Foreman on port ${port}: ${e.message}`);
  process.exit(1);
});

req.write(postData);
req.end();
