/**
 * fetchers/rss.ts
 *
 * RSS news collector for Lofoten sentiment mentions.
 * Fetches from Norwegian and Nordic news/tourism feeds,
 * filters for Lofoten relevance, and stores in sentiment_mentions.
 *
 * Usage:
 *   npm run fetch:rss                  — fetch latest items
 *   npm run fetch:rss -- --days 14     — include items up to 14 days old
 */

import * as path from "path";
import * as dotenv from "dotenv";
import Parser from "rss-parser";
import axios from "axios";
import { getSupabaseAdmin } from "../lib/supabase";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const supabase = getSupabaseAdmin();
const parser   = new Parser({ timeout: 15000 });

// ----------------------------------------------------------------
// Robust RSS fetcher — proper parser first, regex fallback for broken feeds
// ----------------------------------------------------------------
function extractCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function regexParseFeed(xml: string): { items: FeedItem[] } {
  const items: FeedItem[] = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag: string): string | undefined => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const match = r.exec(block);
      return match ? extractCdata(match[1]) : undefined;
    };
    const linkMatch =
      /<link>([\s\S]*?)<\/link>/i.exec(block) ??
      /<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/i.exec(block);
    items.push({
      title:          get("title"),
      link:           linkMatch ? extractCdata(linkMatch[1]) : undefined,
      pubDate:        get("pubDate"),
      isoDate:        get("pubDate"),
      contentSnippet: get("description"),
    });
  }
  return { items };
}

async function fetchFeedRobust(url: string) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: { "User-Agent": "NorData/1.0 (lofoten-rss-monitor; research)" },
    responseType: "text",
  });
  const xml: string = res.data;
  try {
    return await parser.parseString(xml);
  } catch {
    // Fall back to regex extraction for badly malformed XML
    return regexParseFeed(xml);
  }
}

// ----------------------------------------------------------------
// Feed list
// filterLofoten: true  → only keep items mentioning "lofoten"
// filterLofoten: false → keep all items (feed is Lofoten-specific)
// ----------------------------------------------------------------
const FEEDS = [
  // Norwegian national & regional news
  {
    url:           "https://www.nrk.no/nordland/toppsaker.rss",
    name:          "NRK Nordland",
    filterLofoten: true,
  },
  {
    url:           "https://www.nrk.no/toppsaker.rss",
    name:          "NRK",
    filterLofoten: true,
  },
  {
    url:           "https://www.aftenposten.no/rss/",
    name:          "Aftenposten",
    filterLofoten: true,
  },
  {
    url:           "https://www.tv2.no/rss/",
    name:          "TV2",
    filterLofoten: true,
  },
  // International travel media
  {
    url:           "https://www.theguardian.com/travel/rss",
    name:          "The Guardian Travel",
    filterLofoten: true,
  },
];

const LOFOTEN_RE = /lofoten/i;

interface FeedItem {
  title?:       string;
  link?:        string;
  pubDate?:     string;
  isoDate?:     string;
  contentSnippet?: string;
  content?:     string;
  creator?:     string;
  author?:      string;
}

function mentionsLofoten(item: FeedItem): boolean {
  const text = [item.title, item.contentSnippet, item.content]
    .filter(Boolean)
    .join(" ");
  return LOFOTEN_RE.test(text);
}

function parseDate(item: FeedItem): string | null {
  const raw = item.isoDate ?? item.pubDate;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function processFeed(
  feed: (typeof FEEDS)[number],
  cutoff: Date
): Promise<{ fetched: number; saved: number }> {
  const result = await fetchFeedRobust(feed.url);
  const items  = result.items as FeedItem[];

  const candidates = items.filter((item) => {
    if (!item.link || !item.title?.trim()) return false;

    // Date filter
    const pub = parseDate(item);
    if (pub && new Date(pub) < cutoff) return false;

    // Keyword filter
    if (feed.filterLofoten && !mentionsLofoten(item)) return false;

    return true;
  });

  if (candidates.length === 0) return { fetched: 0, saved: 0 };

  const rows = candidates.map((item) => ({
    source:       "news",
    source_id:    null,
    url:          item.link!,
    author:       feed.name,
    title:        item.title!.trim(),
    body:         item.contentSnippet?.trim() ?? null,
    published_at: parseDate(item),
    fetched_at:   new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from("sentiment_mentions")
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
    .select("id");

  if (error) throw new Error(`Upsert failed for ${feed.name}: ${error.message}`);
  return { fetched: candidates.length, saved: data?.length ?? 0 };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args    = process.argv.slice(2);
  const daysIdx = args.indexOf("--days");
  const daysBack = daysIdx !== -1 ? parseInt(args[daysIdx + 1]) : 7;
  const cutoff  = new Date(Date.now() - daysBack * 86_400_000);

  console.log(`\n📡 RSS collector — Lofoten mentions (last ${daysBack} days)\n`);

  let totalFetched = 0;
  let totalNew     = 0;

  for (const feed of FEEDS) {
    process.stdout.write(`  ${feed.name} ... `);
    try {
      const { fetched, saved } = await processFeed(feed, cutoff);
      totalFetched += fetched;
      totalNew     += saved;
      console.log(`${fetched} relevant, ${saved} new`);
    } catch (err) {
      console.log(`❌ ${(err as Error).message}`);
    }
    await sleep(1000);
  }

  console.log(`\n✅ Done — ${totalFetched} items relevant, ${totalNew} new saved`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
