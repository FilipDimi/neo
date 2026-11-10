/**
 * The company's tools as a server a Claude session starts (MCP, over stdio). It holds nothing and
 * decides nothing: each tool is a call to the engine that is already running on this machine.
 *
 *   VS_DATA_DIR=…   where the company lives (default ~/.virtual-startup); the token is read from there
 *   VS_PORT=…       the engine's port (default 4317)
 *
 * Nothing may be written to standard output here except by the transport: that is the wire.
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { whoAnswers } from '../api/whoAnswers.ts';
import { dataDir, paths } from '../db/dataDir.ts';
import { launchEngine, startCompany } from './start.ts';
import { caller, INSTRUCTIONS, runTool, TOOLS, type Call } from './tools.ts';

const port = Number(process.env.VS_PORT ?? 4317);
const dir = dataDir(process.env, false);
const tokenFile = paths(dir).token;
// The engine that is started is the one in this folder: the release these tools themselves run from.
const root = path.resolve(import.meta.dirname, '../..');
const log = path.join(dir, 'logs', 'engine.log');
const start = () => startCompany({ port, who: whoAnswers, launch: () => launchEngine(root, log), log });

/** The token is read at each call: the company may be started, or set up for the first time, after this server. */
const call: Call = (method, route, body) => {
  let token = '';
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    // No company has ever been started here. The call below fails with words that say what to do.
  }
  return caller(port, token)(method, route, body);
};

const server = new McpServer({ name: 'neo', version: '0.1.0' }, { instructions: INSTRUCTIONS });
for (const tool of TOOLS) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: Record<string, unknown>) => {
    const result = await runTool(tool.name, args, { call, start });
    return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
  });
}
await server.connect(new StdioServerTransport());
