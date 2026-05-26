/**
 * fetchers/analyze-sentiment.ts
 *
 * Sentiment analysis pipeline for raw sentiment_mentions rows.
 * For each unanalyzed mention:
 *   1. Sends text to Claude Haiku → sentiment, score, topics, summary, language
 *   2. Generates OpenAI embedding for semantic search
 *   3. Updates the row and refreshes materialized views
 *
 * Usage:
 *   npm run analyze:sentiment                  — process all unanalyzed
 *   npm run analyze:sentiment -- --limit 50    — process max 50
 */

import * as path from "path";
import * as dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getSupabaseAdmin } from "../lib/supabase";

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

const supabase = getSupabaseAdmin();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBED_MODEL = "text-embedding-3-small";
const ANALYSIS_MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 5; // parallel calls per round — stays under 50 req/min rate limit
const MAX_TEXT_CHARS = 2000; // truncate long posts before sending to Claude

interface RawMention {
  id: number;
  source: string;
  title: string | null;
  body: string | null;
}

interface SentimentResult {
  sentiment: "positive" | "neutral" | "negative";
  score: number;
  topics: string[];
  summary: string;
  language: string;
}

const SYSTEM_PROMPT = `You analyze social media posts and news articles about Lofoten, Norway.
Return ONLY valid JSON — no prose, no markdown, no explanation.

Required fields:
{
  "sentiment": "positive" | "neutral" | "negative",
  "score": number from -1.0 (very negative) to 1.0 (very positive),
  "topics": array of 1-5 short lowercase strings (e.g. ["hiking", "weather", "crowding", "aurora", "fishing"]),
  "summary": single sentence, max 120 characters,
  "language": ISO 639-1 code (e.g. "en", "no", "de")
}`;

async function analyzeMention(mention: RawMention): Promise<SentimentResult> {
  const text = [mention.title, mention.body]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_TEXT_CHARS);

  const response = await anthropic.messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text.trim() : "";
  // Strip markdown code fences if the model wraps the JSON
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned) as SentimentResult;
}

async function embedText(mention: RawMention): Promise<number[]> {
  const text = [mention.title, mention.body]
    .filter(Boolean)
    .join(" ")
    .slice(0, 8000);

  const response = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : 1000;

  console.log(`\n🧠 Sentiment analysis — processing unanalyzed mentions (max ${limit})\n`);

  const { data: mentions, error } = await supabase
    .from("sentiment_mentions")
    .select("id, source, title, body")
    .is("analyzed_at", null)
    .order("published_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch mentions: ${error.message}`);
  if (!mentions?.length) {
    console.log("  ✅ Nothing to analyze");
    return;
  }

  console.log(`  Found ${mentions.length} unanalyzed mentions\n`);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < mentions.length; i += BATCH_SIZE) {
    const batch = mentions.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (mention) => {
        try {
          const [result, embedding] = await Promise.all([
            analyzeMention(mention),
            embedText(mention),
          ]);

          const { error: updateErr } = await supabase
            .from("sentiment_mentions")
            .update({
              sentiment: result.sentiment,
              sentiment_score: result.score,
              topics: result.topics,
              summary: result.summary,
              language: result.language,
              embedding: JSON.stringify(embedding),
              analyzed_at: new Date().toISOString(),
            })
            .eq("id", mention.id);

          if (updateErr) throw new Error(updateErr.message);
          processed++;
        } catch (err) {
          console.error(`  ❌ mention ${mention.id}:`, (err as Error).message);
          failed++;
        }
      })
    );

    const done = Math.min(i + BATCH_SIZE, mentions.length);
    console.log(`  ${done}/${mentions.length} — ${processed} ok, ${failed} failed`);

    // Pause between batches to respect 50 req/min rate limit
    if (done < mentions.length) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // Refresh materialized views so MCP tools see fresh data
  console.log("\n  Refreshing materialized views...");
  const { error: refreshErr } = await supabase.rpc("refresh_sentiment_views");
  if (refreshErr) console.error("  ⚠️  View refresh failed:", refreshErr.message);
  else console.log("  ✅ Views refreshed");

  console.log(`\n✅ Done — ${processed} analyzed, ${failed} failed`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
