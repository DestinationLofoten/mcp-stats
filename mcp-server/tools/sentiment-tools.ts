/**
 * mcp-server/tools/sentiment-tools.ts
 *
 * MCP tools for Lofoten sentiment analysis.
 * Four tools: recent mentions, weekly summary, topic breakdown, semantic search.
 * Summary views hit pre-aggregated materialized views — cheap and fast.
 * Semantic search uses pgvector via Supabase RPC.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import { supabase } from "../../lib/supabase";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EMBED_MODEL = "text-embedding-3-small";

// ----------------------------------------------------------------
// Tool definitions
// ----------------------------------------------------------------
export const sentimentTools: Tool[] = [
  {
    name: "sentiment_recent",
    description:
      "Get recent Lofoten mentions with sentiment scores from Reddit (and other sources as added). Returns title, summary, sentiment, score, topics, and URL. Best for 'what are people saying this week' questions.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["news", "google_reviews", "reddit", "tripadvisor"],
          description: "Filter by source platform",
        },
        sentiment: {
          type: "string",
          enum: ["positive", "neutral", "negative"],
          description: "Filter by sentiment",
        },
        days: {
          type: "number",
          description: "Mentions from last N days (default: 7)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 20, max: 50)",
        },
      },
    },
  },
  {
    name: "sentiment_summary",
    description:
      "Weekly sentiment summary aggregated by source. Returns mention counts, average score, and positive/neutral/negative breakdown per week. Best for trend and time-series questions.",
    inputSchema: {
      type: "object",
      properties: {
        weeks: {
          type: "number",
          description: "How many weeks back to include (default: 8)",
        },
        source: {
          type: "string",
          enum: ["news", "google_reviews", "reddit", "tripadvisor"],
          description: "Filter by source",
        },
      },
    },
  },
  {
    name: "sentiment_topics",
    description:
      "Top topics mentioned in Lofoten content over the last 30 days, with count and sentiment breakdown per topic. Use to identify dominant themes in conversation (e.g. hiking, weather, crowding, aurora).",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max number of topics to return (default: 15)",
        },
      },
    },
  },
  {
    name: "sentiment_search",
    description:
      "Semantic search over Lofoten mentions using natural language. More powerful than keyword search — finds mentions by meaning, not exact words. E.g. 'frustration about parking' finds posts that never use the word 'frustration'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        sentiment: {
          type: "string",
          enum: ["positive", "neutral", "negative"],
          description: "Filter results by sentiment",
        },
        source: {
          type: "string",
          enum: ["news", "google_reviews", "reddit", "tripadvisor"],
          description: "Filter by source platform",
        },
        days: {
          type: "number",
          description: "Only search mentions from last N days",
        },
        limit: {
          type: "number",
          description: "Max results (default: 5, max: 10)",
        },
      },
      required: ["query"],
    },
  },
];

// ----------------------------------------------------------------
// Router
// ----------------------------------------------------------------
export async function handleSentimentTool(
  name: string,
  args: Record<string, unknown>
) {
  switch (name) {
    case "sentiment_recent":  return sentimentRecent(args);
    case "sentiment_summary": return sentimentSummary(args);
    case "sentiment_topics":  return sentimentTopics(args);
    case "sentiment_search":  return sentimentSearch(args);
    default:
      throw new Error(`Unknown sentiment tool: ${name}`);
  }
}

// ----------------------------------------------------------------
// sentiment_recent
// ----------------------------------------------------------------
async function sentimentRecent(args: Record<string, unknown>) {
  const days  = Number(args.days  ?? 7);
  const limit = Math.min(Number(args.limit ?? 20), 50);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  let query = supabase
    .from("sentiment_mentions")
    .select(
      "source, title, summary, sentiment, sentiment_score, topics, author, published_at, url"
    )
    .not("analyzed_at", "is", null)
    .gte("published_at", since)
    .order("published_at", { ascending: false })
    .limit(limit);

  if (args.source)    query = query.eq("source",    args.source    as string);
  if (args.sentiment) query = query.eq("sentiment", args.sentiment as string);

  const { data, error } = await query;
  if (error) throw new Error(`sentiment_recent failed: ${error.message}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { count: data?.length ?? 0, days, mentions: data },
          null,
          2
        ),
      },
    ],
  };
}

// ----------------------------------------------------------------
// sentiment_summary
// ----------------------------------------------------------------
async function sentimentSummary(args: Record<string, unknown>) {
  const weeks  = Number(args.weeks ?? 8);
  const cutoff = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString();

  let query = supabase
    .from("sentiment_weekly_summary")
    .select("*")
    .gte("week_start", cutoff)
    .order("week_start", { ascending: false });

  if (args.source) query = query.eq("source", args.source as string);

  const { data, error } = await query;
  if (error) throw new Error(`sentiment_summary failed: ${error.message}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ weeks, summary: data }, null, 2),
      },
    ],
  };
}

// ----------------------------------------------------------------
// sentiment_topics
// ----------------------------------------------------------------
async function sentimentTopics(args: Record<string, unknown>) {
  const limit = Math.min(Number(args.limit ?? 15), 30);

  const { data, error } = await supabase
    .from("sentiment_topics_30d")
    .select("*")
    .order("mention_count", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`sentiment_topics failed: ${error.message}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { period: "last_30_days", topics: data },
          null,
          2
        ),
      },
    ],
  };
}

// ----------------------------------------------------------------
// sentiment_search
// ----------------------------------------------------------------
async function sentimentSearch(args: Record<string, unknown>) {
  const query = args.query as string;
  const limit = Math.min(Number(args.limit ?? 5), 10);

  const embResponse = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: query,
  });
  const embedding = embResponse.data[0].embedding;

  const { data, error } = await supabase.rpc("match_sentiment_mentions", {
    query_embedding:  embedding,
    match_threshold:  0.5,
    match_count:      limit,
    filter_source:    (args.source    as string) ?? null,
    filter_sentiment: (args.sentiment as string) ?? null,
    filter_days:      (args.days      as number) ?? null,
  });

  if (error) throw new Error(`sentiment_search failed: ${error.message}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { query, count: data?.length ?? 0, results: data },
          null,
          2
        ),
      },
    ],
  };
}
