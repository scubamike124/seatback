// EXAMPLE ONLY, NOT RUN, NOT PART OF THE BUILD. Shows how the kit's backend example would call
// `qloo mcp` (kit starter/mcp-client/backend.mjs). Needs two things this project does NOT have and
// has NOT installed: the kit's `qloo` harness and @modelcontextprotocol/sdk. The kit says serverless
// (Cloudflare Workers) is not a supported route for `qloo mcp`, so Seatback keeps REST.
// It does nothing unless run with --i-have-reviewed-and-installed-the-kit. It never reads a key itself:
// the harness reads QLOO_API_KEY from the environment of the process that starts it.
export const MCP_EXAMPLE_STATUS = 'not-run' as const;

export async function callQlooMcp(query: string): Promise<unknown> {
  const sdkName = '@modelcontextprotocol/sdk/client/index.js';
  const stdioName = '@modelcontextprotocol/sdk/client/stdio.js';
  const { Client } = (await import(sdkName)) as { Client: new (i: unknown, o: unknown) => any };
  const { StdioClientTransport } = (await import(stdioName)) as { StdioClientTransport: new (o: unknown) => any };
  const client = new Client({ name: 'seatback', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: 'qloo', args: ['mcp'], env: process.env }));
  try {
    await client.callTool({ name: 'qloo_capabilities', arguments: {} }); // readiness; no Qloo call
    return await client.callTool({ name: 'qloo_find_tags', arguments: { query, limit: 5 } });
  } finally {
    await client.close();
  }
}

if (process.argv[1]?.endsWith('qloo-mcp-example.ts') && process.argv.includes('--i-have-reviewed-and-installed-the-kit')) {
  console.log(JSON.stringify(await callQlooMcp(process.argv[2] ?? 'holiday')));
} else if (process.argv[1]?.endsWith('qloo-mcp-example.ts')) {
  console.log('Example only; not run. See the header of this file.');
}
