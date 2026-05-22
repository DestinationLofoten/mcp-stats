/**
 * fetchers/documents.ts
 *
 * RAG ingest pipeline for NorData MCP.
 * Downloads files from Google Drive, parses text, chunks, embeds via OpenAI,
 * and upserts into Supabase (documents + document_chunks).
 *
 * Usage:
 *   npm run fetch:docs                        — ingest all new files in Drive folder
 *   npm run fetch:docs -- --file <drive_id>   — ingest single file
 *   npm run fetch:docs -- --force             — re-ingest even if already indexed
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import { getSupabaseAdmin } from "../lib/supabase";
// @ts-ignore — no bundled types
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { encoding_for_model } from "tiktoken";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const supabase = getSupabaseAdmin();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHUNK_SIZE   = 700;  // tokens
const CHUNK_OVERLAP = 70;  // tokens (10 %)
const MIN_CHUNK    = 100;  // tokens — skip tiny leftovers
const EMBED_BATCH  = 100;  // chunks per OpenAI call
const EMBED_MODEL  = "text-embedding-3-small";

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------
interface DocumentMeta {
  driveId: string;
  title: string;
  sourceUrl: string;
  category: string;
  year?: number;
  publisher?: string;
  municipality?: string;
  fileType: "pdf" | "docx";
}

// ----------------------------------------------------------------
// Text extraction
// ----------------------------------------------------------------
async function extractText(
  buffer: Buffer,
  fileType: string
): Promise<{ text: string; pageCount: number }> {
  if (fileType === "pdf") {
    const result = await pdfParse(buffer);
    return { text: result.text, pageCount: result.numpages };
  }
  if (fileType === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, pageCount: 0 };
  }
  throw new Error(`Unsupported file type: ${fileType}`);
}

// ----------------------------------------------------------------
// Chunking
// ----------------------------------------------------------------
function chunkText(text: string): string[] {
  const enc = encoding_for_model("text-embedding-3-small");
  const tokens = enc.encode(text);
  const chunks: string[] = [];

  let start = 0;
  while (start < tokens.length) {
    const end = Math.min(start + CHUNK_SIZE, tokens.length);
    const chunkTokens = tokens.slice(start, end);
    if (chunkTokens.length >= MIN_CHUNK) {
      const decoded = new TextDecoder().decode(enc.decode(chunkTokens));
      chunks.push(decoded.trim());
    }
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  enc.free();
  return chunks;
}

// ----------------------------------------------------------------
// Embedding
// ----------------------------------------------------------------
async function embedChunks(chunks: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const response = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: batch,
    });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    embeddings.push(...sorted.map((e) => e.embedding));
    console.log(`   🔢 Embedded ${Math.min(i + EMBED_BATCH, chunks.length)}/${chunks.length} chunks`);
  }

  return embeddings;
}

// ----------------------------------------------------------------
// Main ingest function
// ----------------------------------------------------------------
export async function ingestDocument(
  meta: DocumentMeta,
  fileBuffer: Buffer,
  force = false
): Promise<{ documentId: string; chunksCreated: number }> {
  console.log(`\n📄 Ingesting: ${meta.title}`);

  // Check if already ingested
  if (!force) {
    const { data: existing } = await supabase
      .from("documents")
      .select("id")
      .eq("drive_id", meta.driveId)
      .single();

    if (existing) {
      console.log(`   ⏭️  Already ingested (use --force to re-ingest)`);
      return { documentId: existing.id, chunksCreated: 0 };
    }
  }

  // Start ingest log
  const { text, pageCount } = await extractText(fileBuffer, meta.fileType);
  console.log(`   📝 Extracted ${text.length} characters, ${pageCount} pages`);

  const chunks = chunkText(text);
  console.log(`   ✂️  Split into ${chunks.length} chunks`);

  const embeddings = await embedChunks(chunks);

  // Upsert document
  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .upsert(
      {
        title: meta.title,
        source_url: meta.sourceUrl,
        drive_id: meta.driveId,
        category: meta.category,
        year: meta.year ?? null,
        publisher: meta.publisher ?? null,
        municipality: meta.municipality ?? null,
        file_type: meta.fileType,
        page_count: pageCount || null,
        ingested_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "drive_id" }
    )
    .select("id")
    .single();

  if (docErr || !doc) throw new Error(`Failed to upsert document: ${docErr?.message}`);

  // Delete old chunks if re-ingesting
  await supabase.from("document_chunks").delete().eq("document_id", doc.id);

  // Insert chunks
  const chunkRows = chunks.map((content, i) => ({
    document_id: doc.id,
    chunk_index: i,
    content,
    page_number: null, // page tracking not yet implemented
    embedding: JSON.stringify(embeddings[i]),
    token_count: Math.min(CHUNK_SIZE, content.length),
  }));

  for (let i = 0; i < chunkRows.length; i += 500) {
    const batch = chunkRows.slice(i, i + 500);
    const { error } = await supabase.from("document_chunks").insert(batch);
    if (error) throw new Error(`Failed to insert chunks: ${error.message}`);
    console.log(`   ✅ Saved ${Math.min(i + 500, chunkRows.length)}/${chunkRows.length} chunks`);
  }

  // Log success
  await supabase.from("ingest_log").insert({
    document_id: doc.id,
    status: "done",
    chunks_created: chunks.length,
    finished_at: new Date().toISOString(),
  });

  console.log(`   ✅ Done — ${chunks.length} chunks saved`);
  return { documentId: doc.id, chunksCreated: chunks.length };
}

// ----------------------------------------------------------------
// Download from URL (for manual testing / direct URL ingest)
// ----------------------------------------------------------------
async function downloadFile(url: string): Promise<Buffer> {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

// ----------------------------------------------------------------
// CLI entry point (for manual ingest from local file)
// ----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const fileIdx = args.indexOf("--file");

  if (fileIdx !== -1) {
    // Single file mode: --file <local_path> --drive-id <id> --title <title> --category <cat>
    const filePath = args[fileIdx + 1];
    const driveIdIdx = args.indexOf("--drive-id");
    const driveId = driveIdIdx !== -1 ? args[driveIdIdx + 1] : "local-" + Date.now();
    const title = args[args.indexOf("--title") + 1] ?? path.basename(filePath);
    const category = args[args.indexOf("--category") + 1] ?? "annet";
    const municipality = args[args.indexOf("--municipality") + 1] ?? undefined;
    const publisher = args[args.indexOf("--publisher") + 1] ?? undefined;
    const year = args[args.indexOf("--year") + 1] ? parseInt(args[args.indexOf("--year") + 1]) : undefined;
    const fileType = filePath.endsWith(".pdf") ? "pdf" : "docx";

    const buffer = fs.readFileSync(filePath);
    await ingestDocument(
      { driveId, title, sourceUrl: filePath, category, year, publisher, municipality, fileType },
      buffer,
      force
    );
  } else {
    console.log("Usage: npm run fetch:docs -- --file <path> --title <title> --category <category>");
    console.log("Optional: --drive-id <id> --publisher <pub> --municipality <mun> --year <year> --force");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
