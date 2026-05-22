/**
 * report-agent/agent.ts
 *
 * NorData Report Agent
 * Spawns the MCP server as a subprocess, wires up its tools to Claude,
 * and runs an agentic loop until the report is complete.
 *
 * Usage:
 *   npm run report
 *   npm run report -- "Generer ein rapport om overnattingar i Nordland"
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { SSB_REPORT_SYSTEM_PROMPT } from "./prompts/ssb-report";

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
});

const MCP_SERVER_PATH = path.resolve(__dirname, "../mcp-server/index.ts");

// ----------------------------------------------------------------
// Connect to the MCP server and return tools in Anthropic format
// ----------------------------------------------------------------
async function createMcpClient() {
  const transport = new StdioClientTransport({
    command: "ts-node",
    args: [MCP_SERVER_PATH],
    env: { ...process.env } as Record<string, string>,
  });

  const mcpClient = new Client({ name: "nordata-report-agent", version: "1.0.0" });
  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();

  const anthropicTools: Anthropic.Tool[] = tools.map((t, i) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    // Cache the full tool list at the last entry — stable across all loop iterations
    ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));

  return { mcpClient, anthropicTools };
}

// ----------------------------------------------------------------
// Agentic loop — keeps calling Claude until it stops using tools
// ----------------------------------------------------------------
async function generateReport(prompt: string): Promise<string> {
  console.log("\n NorData Report Agent\n");
  console.log(`Request: ${prompt}\n`);
  console.log("─".repeat(60));

  const { mcpClient, anthropicTools } = await createMcpClient();

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt },
  ];

  let report = "";

  try {
    while (true) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8096,
        system: [
          {
            type: "text",
            text: SSB_REPORT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: anthropicTools,
        messages,
      });

      // Collect any text from this turn
      const textBlocks = response.content.filter((b) => b.type === "text");
      if (textBlocks.length > 0) {
        report = textBlocks.map((b) => (b as Anthropic.TextBlock).text).join("\n");
      }

      if (response.stop_reason === "end_turn") break;

      if (response.stop_reason !== "tool_use") break;

      // Append assistant message
      messages.push({ role: "assistant", content: response.content });

      // Handle all tool calls in this turn
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const tb = block as Anthropic.ToolUseBlock;
        console.log(`  Calling tool: ${tb.name}`);

        const result = await mcpClient.callTool({
          name: tb.name,
          arguments: tb.input as Record<string, unknown>,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: tb.id,
          content: result.content as string,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  } finally {
    await mcpClient.close();
  }

  return report;
}

// ----------------------------------------------------------------
// Save report to file
// ----------------------------------------------------------------
function saveReport(report: string, prompt: string): string {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9æøå]+/g, "-")
    .slice(0, 40);
  const filename = `report-${timestamp}-${slug}.md`;
  const outputDir = path.resolve(__dirname, "../reports");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, report, "utf-8");
  return filepath;
}

// ----------------------------------------------------------------
// Interactive CLI loop
// ----------------------------------------------------------------
async function interactiveMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string) =>
    new Promise<string>((resolve) => rl.question(q, resolve));

  console.log("NorData Report Agent");
  console.log('   Type your report request, or "exit" to quit.\n');

  while (true) {
    const prompt = await ask("Report request > ");

    if (prompt.trim().toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
      break;
    }

    if (!prompt.trim()) continue;

    try {
      const report = await generateReport(prompt);

      console.log("\n" + "═".repeat(60));
      console.log(report);
      console.log("═".repeat(60) + "\n");

      const save = await ask("Save report to file? (y/n) > ");
      if (save.toLowerCase() === "y") {
        const filepath = saveReport(report, prompt);
        console.log(`Saved to: ${filepath}\n`);
      }
    } catch (err) {
      console.error("Error generating report:", err);
    }
  }
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    const prompt = args.join(" ");
    const report = await generateReport(prompt);
    console.log("\n" + report);
    const filepath = saveReport(report, prompt);
    console.log(`\nSaved to: ${filepath}`);
  } else {
    await interactiveMode();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
