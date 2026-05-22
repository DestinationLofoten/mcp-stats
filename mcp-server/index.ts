/**
 * mcp-server/index.ts
 *
 * NorData MCP Server
 * Exposes Supabase data as tools that Claude can call.
 *
 * Connect to Claude Desktop by adding to claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "nordata": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/nordata/dist/mcp-server/index.js"]
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";

import { brregTools, handleBrregTool } from "./tools/brreg-tools";
import { ssbTools, handleSsbTool } from "./tools/ssb-tools";
import { documentTools, handleDocumentTool } from "./tools/document-tools";
import { sentimentTools, handleSentimentTool } from "./tools/sentiment-tools";

dotenv.config();

// ----------------------------------------------------------------
// Create MCP server
// ----------------------------------------------------------------
const server = new Server(
  {
    name: "nordata",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ----------------------------------------------------------------
// Register all tools
// ----------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...brregTools, ...ssbTools, ...documentTools, ...sentimentTools],
}));

// ----------------------------------------------------------------
// Route tool calls
// ----------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Brreg tools
    if (name.startsWith("brreg_")) {
      return await handleBrregTool(name, args ?? {});
    }

    // SSB tools
    if (name.startsWith("ssb_")) {
      return await handleSsbTool(name, args ?? {});
    }

    // Document RAG tools
    if (name.startsWith("doc_")) {
      return await handleDocumentTool(name, args ?? {});
    }

    // Sentiment analysis tools
    if (name.startsWith("sentiment_")) {
      return await handleSentimentTool(name, args ?? {});
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ----------------------------------------------------------------
// Start server
// ----------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NorData MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
