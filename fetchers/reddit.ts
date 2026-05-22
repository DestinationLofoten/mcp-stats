/**
 * fetchers/reddit.ts
 *
 * Reddit collector for Lofoten sentiment mentions.
 * Uses Reddit's public JSON API — no OAuth required.
 * Searches multiple queries, deduplicates by URL, and stores
 * raw (unanalyzed) rows in sentiment_mentions.
 *
 * Usage:
 *   npm run fetch:reddit                  — fetch last 7 days
 *   npm run fetch:reddit -- --days 30     — fetch last 30 days
 */

import * as path from "path";
import * as dotenv from "dotenv";
import axios from "axios";
import { getSupabaseAdmin } from "../lib/supabase";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const supabase = getSupabaseAdmin();

// Queries to run against Reddit search
const SEARCH_QUERIES = [
  "lofoten",
  "lofoten islands",
  "lofoten norway",
];

const USER_AGENT = "NorData/1.0 (lofoten-sentiment; research project)";
const MAX_PAGES_PER_QUERY = 5; // 100 posts/page → max 500 per query

interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  author: string;
  permalink: string;
  created_utc: number;
  subreddit: string;
  score: number;
  num_comments: number;
  is_self: boolean;
}

async function fetchPage(
  query: string,
  after?: string
): Promise<{ posts: RedditPost[]; after?: string }> {
  const params = new URLSearchParams({
    q: query,
    sort: "new",
    limit: "100",
    type: "link",
    ...(after ? { after } : {}),
  });

  const response = await axios.get(
    `https://www.reddit.com/search.json?${params}`,
    {
      headers: { "User-Agent": USER_AGENT },
      timeout: 15000,
    }
  );

  const data = response.data?.data;
  if (!data?.children) return { posts: [] };

  const posts: RedditPost[] = data.children.map(
    (c: { data: RedditPost }) => c.data
  );

  return {
    posts,
    after: posts.length === 100 ? data.after : undefined,
  };
}

async function upsertMentions(posts: RedditPost[]): Promise<number> {
  if (posts.length === 0) return 0;

  const rows = posts
    .filter((p) => p.title?.trim())
    .map((p) => ({
      source: "reddit",
      source_id: p.id,
      url: `https://www.reddit.com${p.permalink}`,
      author: p.author === "[deleted]" ? null : p.author,
      title: p.title,
      body: p.selftext?.trim() || null,
      published_at: new Date(p.created_utc * 1000).toISOString(),
      fetched_at: new Date().toISOString(),
    }));

  // ignoreDuplicates skips rows where url already exists
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
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf("--days");
  const daysBack = daysIdx !== -1 ? parseInt(args[daysIdx + 1]) : 7;
  const cutoffTimestamp = Date.now() / 1000 - daysBack * 86400;

  console.log(`\n🔍 Reddit collector — Lofoten mentions (last ${daysBack} days)\n`);

  let totalFetched = 0;
  let totalNew = 0;

  for (const query of SEARCH_QUERIES) {
    console.log(`  Query: "${query}"`);

    let after: string | undefined;
    let page = 0;
    let stop = false;

    while (page < MAX_PAGES_PER_QUERY && !stop) {
      const { posts, after: nextAfter } = await fetchPage(query, after);

      // Filter to posts within our time window
      const inWindow = posts.filter((p) => p.created_utc >= cutoffTimestamp);
      totalFetched += inWindow.length;

      if (inWindow.length > 0) {
        const saved = await upsertMentions(inWindow);
        totalNew += saved;
        console.log(
          `    Page ${page + 1}: ${inWindow.length} in window, ${saved} new`
        );
      }

      // Stop if we've hit posts older than our window, or no more pages
      if (posts.some((p) => p.created_utc < cutoffTimestamp) || !nextAfter) {
        stop = true;
      }

      after = nextAfter;
      page++;

      // Respect Reddit's rate limit (1 req/sec recommended)
      await sleep(1200);
    }
  }

  console.log(`\n✅ Done — ${totalFetched} posts in window, ${totalNew} new saved`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
