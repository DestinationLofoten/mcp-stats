/**
 * fetchers/gdelt.ts
 *
 * News collector for Lofoten sentiment mentions using the GDELT Project API.
 * GDELT monitors thousands of global news sources — no API key required.
 * Stores raw (unanalyzed) rows in sentiment_mentions with source = 'news'.
 *
 * Usage:
 *   npm run fetch:news                  — fetch last 7 days
 *   npm run fetch:news -- --days 14     — fetch last 14 days (max 30)
 *
 * GDELT API docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
 */

import * as path from "path";
import * as dotenv from "dotenv";
import axios from "axios";
import { getSupabaseAdmin } from "../lib/supabase";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const supabase = getSupabaseAdmin();

const SEARCH_QUERIES = ["lofoten", "lofoten norway", "lofoten islands"];
const GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

interface GdeltArticle {
  url:           string;
  title:         string;
  seendate:      string; // e.g. "20260522T135500Z"
  domain:        string;
  language:      string;
  sourcecountry: string;
}

// Parse GDELT's compact date format: "20260522T135500Z"
function parseGdeltDate(seendate: string): string {
  const m = seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return new Date().toISOString();
  return new Date(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`
  ).toISOString();
}

async function fetchGdelt(
  query: string,
  daysBack: number,
  attempt = 1
): Promise<GdeltArticle[]> {
  // GDELT timespan format: "1d", "7d", "30d" (max ~3 months)
  const days     = Math.min(daysBack, 30);
  const timespan = `${days}d`;

  const params = new URLSearchParams({
    query,
    mode:       "artlist",
    maxrecords: "250",
    format:     "json",
    timespan,
    sort:       "datedesc",
  });

  try {
    const response = await axios.get(`${GDELT_URL}?${params}`, {
      timeout: 30000,
      headers: { "User-Agent": "NorData/1.0 (lofoten-news-monitor; research)" },
    });
    return response.data?.articles ?? [];
  } catch (err) {
    if (attempt < 3) {
      console.log(`    ⚠️  Attempt ${attempt} failed, retrying in 5s...`);
      await sleep(5000);
      return fetchGdelt(query, daysBack, attempt + 1);
    }
    throw err;
  }
}

async function upsertMentions(articles: GdeltArticle[]): Promise<number> {
  if (articles.length === 0) return 0;

  const rows = articles
    .filter((a) => a.url && a.title?.trim())
    .map((a) => ({
      source:       "news",
      source_id:    null,
      url:          a.url,
      author:       a.domain,        // use domain as author proxy
      title:        a.title,
      body:         null,            // GDELT doesn't provide article body
      published_at: parseGdeltDate(a.seendate),
      fetched_at:   new Date().toISOString(),
    }));

  const { data, error } = await supabase
    .from("sentiment_mentions")
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
    .select("id");

  if (error) throw new Error(`Upsert failed: ${error.message}`);
  return data?.length ?? 0;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args     = process.argv.slice(2);
  const daysIdx  = args.indexOf("--days");
  const daysBack = daysIdx !== -1 ? parseInt(args[daysIdx + 1]) : 7;

  console.log(`\n📰 GDELT news collector — Lofoten mentions (last ${daysBack} days)\n`);

  let totalFetched = 0;
  let totalNew     = 0;

  for (const query of SEARCH_QUERIES) {
    console.log(`  Query: "${query}"`);

    try {
      const articles = await fetchGdelt(query, daysBack);
      totalFetched  += articles.length;

      const saved  = await upsertMentions(articles);
      totalNew    += saved;
      console.log(`    ${articles.length} articles fetched, ${saved} new`);
    } catch (err) {
      console.error(`    ❌ Failed: ${(err as Error).message}`);
    }

    // Be polite to GDELT's free API
    await sleep(2000);
  }

  console.log(`\n✅ Done — ${totalFetched} articles fetched, ${totalNew} new saved`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
