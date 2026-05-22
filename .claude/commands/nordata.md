# NorData – system overview

You are connected to the NorData MCP server, a live pipeline from Norwegian public data sources into a query engine Claude can call directly.

Run the following steps and present the results as a polished overview — suitable for showing what the system can do.

## 1. Datasources
Call `ssb_list_datasets` to list all SSB tables available, then summarise each with table ID, title and what it covers.

## 2. Live spot-check: Lofoten markets
Call `ssb_overnights_by_market` with:
- region: "Lofoten"
- time_period: the most recent month you can find (try 2025M12, fall back if needed)
- exclude_aggregates: true
- order_by: "total_overnights"
- limit: 10

Show the top 10 origin markets for Lofoten in that month as a clean table with rank, country and overnights.

## 3. Present the tools
List all available MCP tools grouped by category:
- **SSB** (Statistics Norway) — overnight stays, employment, time series
- **Brreg** — Norwegian company registry
- **Documents** — RAG search over ingested reports and strategy documents

For each tool, one sentence on what it does and a typical use case.

## 4. Closing
End with a one-paragraph pitch: what kinds of questions this system can answer that would otherwise require manual data wrangling in Excel or SSB's own web interface.

Keep the tone confident and concrete. Use tables and headers. No fluff.
