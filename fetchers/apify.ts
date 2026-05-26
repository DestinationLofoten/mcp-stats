/**
 * fetchers/apify.ts
 *
 * Pulls Google Reviews from Apify datasets into sentiment_mentions.
 * Reads the latest successful run of the Google Maps Reviews Scraper
 * actor and upserts all reviews into Supabase for analysis.
 *
 * Usage:
 *   npm run fetch:reviews          — fetch latest dataset from last run
 *   npm run fetch:reviews -- --all — re-fetch all items (ignores duplicates)
 *
 * Apify actor: Google Maps Reviews Scraper (Xb8osYTtOjlsgI6k9)
 * Schedule: Run in Apify dashboard weekly; this script just pulls results.
 */

import * as path from "path";
import * as dotenv from "dotenv";
import axios from "axios";
import { getSupabaseAdmin } from "../lib/supabase";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const supabase    = getSupabaseAdmin();
const APIFY_TOKEN = process.env.APIFY_TOKEN!;
const ACTOR_ID    = "Xb8osYTtOjlsgI6k9"; // Google Maps Reviews Scraper

const APIFY_BASE  = "https://api.apify.com/v2";

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------
interface ApifyReview {
  reviewId:          string;
  text:              string | null;
  textTranslated:    string | null;
  stars:             number | null;
  publishedAtDate:   string | null;
  searchString:      string | null;
  isLocalGuide:      boolean;
  reviewerNumberOfReviews: number;
  reviewOrigin:      string;
}

// ----------------------------------------------------------------
// Extract business name from Apify's searchString field
// e.g. "Direct Detail URL: https://...maps/place/Paleo+Arctic/@..."
// ----------------------------------------------------------------
function extractBusinessName(searchString: string | null): string {
  if (!searchString) return "Unknown";
  const m = searchString.match(/maps\/place\/([^/@]+)/);
  if (!m) return "Unknown";
  return decodeURIComponent(m[1].replace(/\+/g, " ")).trim();
}

// ----------------------------------------------------------------
// Fetch latest successful run dataset
// ----------------------------------------------------------------
async function getLatestDatasetId(): Promise<string> {
  const { data } = await axios.get(
    `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}&limit=10&status=SUCCEEDED`,
    { timeout: 15000 }
  );
  const runs = data?.data?.items ?? [];
  if (runs.length === 0) throw new Error("No successful Apify runs found.");
  return runs[0].defaultDatasetId as string;
}

async function fetchDataset(datasetId: string): Promise<ApifyReview[]> {
  const { data } = await axios.get(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=10000`,
    { timeout: 30000 }
  );
  return data as ApifyReview[];
}

// ----------------------------------------------------------------
// Upsert reviews into sentiment_mentions
// ----------------------------------------------------------------
async function upsertReviews(reviews: ApifyReview[]): Promise<number> {
  const rows = reviews
    .filter((r) => r.reviewId && (r.text || r.textTranslated))
    .map((r) => {
      const business = extractBusinessName(r.searchString);
      const body     = r.text ?? r.textTranslated ?? null;
      const stars    = r.stars ?? null;

      return {
        source:       "google_reviews",
        source_id:    r.reviewId,
        // Unique URL constructed from reviewId — no direct Google review URL available
        url:          `google:review:${r.reviewId}`,
        author:       business,
        // Title includes star rating for quick scanning
        title:        stars ? `${business} — ${"★".repeat(stars)}${"☆".repeat(5 - stars)}` : business,
        body,
        published_at: r.publishedAtDate ?? null,
        fetched_at:   new Date().toISOString(),
      };
    });

  if (rows.length === 0) return 0;

  const { data, error } = await supabase
    .from("sentiment_mentions")
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
    .select("id");

  if (error) throw new Error(`Upsert failed: ${error.message}`);
  return data?.length ?? 0;
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------
async function main() {
  console.log("\n⭐ Apify Google Reviews — fetching latest dataset\n");

  const datasetId = await getLatestDatasetId();
  console.log(`  Dataset: ${datasetId}`);

  const reviews = await fetchDataset(datasetId);
  console.log(`  Reviews in dataset: ${reviews.length}`);

  // Summary by business
  const byBusiness: Record<string, number> = {};
  reviews.forEach((r) => {
    const name = extractBusinessName(r.searchString);
    byBusiness[name] = (byBusiness[name] ?? 0) + 1;
  });
  Object.entries(byBusiness).forEach(([name, count]) =>
    console.log(`    ${name}: ${count} reviews`)
  );

  const saved = await upsertReviews(reviews);
  console.log(`\n✅ Done — ${reviews.length} fetched, ${saved} new saved`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
