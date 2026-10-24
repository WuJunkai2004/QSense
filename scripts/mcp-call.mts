import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const token = process.env.MCP_TOKEN ?? "未设置 MCP_TOKEN 环境变量";
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'm4-live', version: '0.0.1' });
await client.connect(transport);
const args = JSON.parse(process.env.CALL_ARGS!);
const res = (await client.callTool({ name: process.env.CALL_TOOL!, arguments: args })) as {
  isError?: boolean; content: Array<{ text: string }>;
};
console.log(res.content[0]?.text);
await client.close();
