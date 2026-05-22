# NorData — Norwegian Data Pipeline & Report Agent

A full-stack system that fetches data from Norwegian public APIs, stores it in Supabase, exposes it via a custom MCP server, and generates AI-powered reports.

## Architecture

```
Brreg API ──┐
            ├──▶ Fetcher Scripts ──▶ Supabase DB ──▶ MCP Server ──▶ Claude Agent ──▶ Reports
SSB API ────┘
```

## Project Structure

```
nordata/
├── README.md
├── package.json                  # Root workspace
├── .env.example                  # Environment variables template
│
├── fetchers/                     # Data fetching scripts
│   ├── brreg.ts                  # Brønnøysundregistrene fetcher
│   ├── ssb.ts                    # SSB StatBank fetcher
│   └── run-all.ts                # Run all fetchers
│
├── db/
│   └── schema.sql                # Supabase schema + migrations
│
├── mcp-server/                   # Custom MCP server
│   ├── index.ts                  # MCP server entry point
│   └── tools/
│       ├── brreg-tools.ts        # Brreg query tools
│       └── ssb-tools.ts          # SSB query tools
│
└── report-agent/                 # Report generation agent
    ├── agent.ts                  # Claude-powered report agent
    ├── prompts/
    │   └── ssb-report.ts         # SSB report system prompt
    └── ui/
        └── index.html            # Simple report request UI
```

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
# Fill in your Supabase URL, anon key, and Anthropic API key
```

### 3. Run the database schema
```bash
# In Supabase dashboard > SQL Editor, run db/schema.sql
```

### 4. Fetch data
```bash
npm run fetch:brreg
npm run fetch:ssb
# or both:
npm run fetch:all
```

### 5. Start the MCP server
```bash
npm run mcp
```

### 6. Connect MCP to Claude Desktop
Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "nordata": {
      "command": "node",
      "args": ["/absolute/path/to/nordata/dist/mcp-server/index.js"],
      "env": {
        "SUPABASE_URL": "your-url",
        "SUPABASE_ANON_KEY": "your-key"
      }
    }
  }
}
```

### 7. Generate a report
```bash
npm run report
```

## Environment Variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon/public key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SSB_BASE_URL` | SSB API base URL (default set) |
| `BRREG_BASE_URL` | Brreg API base URL (default set) |

## APIs Used

- **Brønnøysundregistrene** — `https://data.brreg.no/enhetsregisteret/api`
- **SSB StatBank** — `https://data.ssb.no/api/v0`
