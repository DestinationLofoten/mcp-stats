/**
 * mcp-server/tools/document-tools.ts
 *
 * MCP tools for semantic search over ingested documents (RAG).
 * Uses pgvector + OpenAI embeddings via Supabase RPC.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import { supabase } from "../../lib/supabase";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EMBED_MODEL = "text-embedding-3-small";

// ----------------------------------------------------------------
// Tool definitions
// ----------------------------------------------------------------
export const documentTools: Tool[] = [
  {
    name: "doc_search",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description:
      "Søk i biblioteket av offentlige dokumenter: reiselivsstrategier, kommuneplaner, NHO-rapporter, Menon-analyser og andre utredninger. Bruk dette verktøyet — ikke web_search — for dokumenter som er lastet inn i systemet. Returner alltid kildetittel og sidetall i svaret. Bruk gjerne flere søk med ulike formuleringer for å dekke samme tema.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Naturlig språk-spørsmål eller søkefraser",
        },
        category: {
          type: "string",
          enum: ["strategi", "rapport", "plan", "utredning", "statistikk", "annet"],
          description: "Filtrer på dokumentkategori",
        },
        year: {
          type: "number",
          description: "Filtrer på utgivelsesår",
        },
        municipality: {
          type: "string",
          description: "Filtrer på kommune/region (f.eks. 'Vågan', 'Lofoten')",
        },
        top_k: {
          type: "number",
          description: "Antall chunks som returneres (standard: 5, maks: 10)",
        },
        threshold: {
          type: "number",
          description: "Minimum likhet 0–1 (standard: 0.5). Senk til 0.3 for bredere søk.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "doc_list",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "List alle dokumenter som er indeksert i RAG-systemet. Bruk dette for å se hva som finnes før du søker, eller når du er usikker på om et dokument er lastet inn.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["strategi", "rapport", "plan", "utredning", "statistikk", "annet"],
          description: "Filtrer på kategori",
        },
        municipality: {
          type: "string",
          description: "Filtrer på kommune/region",
        },
        year_from: {
          type: "number",
          description: "Vis dokumenter fra og med dette året",
        },
        year_to: {
          type: "number",
          description: "Vis dokumenter til og med dette året",
        },
      },
    },
  },
  {
    name: "doc_ingest",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description:
      "Ingest et dokument inn i RAG-systemet fra en lokal filsti. Etter ingest er dokumentet søkbart via doc_search. Bruk force_reingest hvis dokumentet er oppdatert og må re-prosesseres.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolutt filsti til PDF eller DOCX",
        },
        title: {
          type: "string",
          description: "Dokumenttittel",
        },
        category: {
          type: "string",
          enum: ["strategi", "rapport", "plan", "utredning", "statistikk", "annet"],
          description: "Dokumentkategori",
        },
        drive_id: {
          type: "string",
          description: "Google Drive fil-ID (valgfri, brukes som unik nøkkel)",
        },
        source_url: {
          type: "string",
          description: "URL til kildedokumentet (f.eks. Google Drive-lenke)",
        },
        year: {
          type: "number",
          description: "Utgivelsesår",
        },
        publisher: {
          type: "string",
          description: "Utgiver (f.eks. 'NHO Reiseliv', 'Vågan kommune')",
        },
        municipality: {
          type: "string",
          description: "Kommune/region dokumentet omhandler",
        },
        force_reingest: {
          type: "boolean",
          description: "Slett og re-prosesser selv om dokumentet allerede er indeksert",
        },
      },
      required: ["file_path", "title", "category"],
    },
  },
];

// ----------------------------------------------------------------
// Router
// ----------------------------------------------------------------
export async function handleDocumentTool(
  name: string,
  args: Record<string, unknown>
) {
  switch (name) {
    case "doc_search":  return docSearch(args);
    case "doc_list":    return docList(args);
    case "doc_ingest":  return docIngest(args);
    default:
      throw new Error(`Unknown document tool: ${name}`);
  }
}

// ----------------------------------------------------------------
// doc_search
// ----------------------------------------------------------------
async function docSearch(args: Record<string, unknown>) {
  const query     = args.query as string;
  const topK      = Math.min(Number(args.top_k ?? 5), 10);
  const threshold = Number(args.threshold ?? 0.5);

  // Embed the query
  const embResponse = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: query,
  });
  const embedding = embResponse.data[0].embedding;

  // Call Supabase RPC
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding:     embedding,
    match_threshold:     threshold,
    match_count:         topK,
    filter_category:     (args.category as string) ?? null,
    filter_year:         (args.year as number)     ?? null,
    filter_municipality: (args.municipality as string) ?? null,
  });

  if (error) throw new Error(`doc_search failed: ${error.message}`);

  const results = (data ?? []).map((r: Record<string, unknown>) => ({
    title:        r.title,
    category:     r.category,
    year:         r.year,
    publisher:    r.publisher,
    municipality: r.municipality,
    page_number:  r.page_number,
    similarity:   Math.round((r.similarity as number) * 100) / 100,
    content:      r.content,
    source_url:   r.source_url,
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            query,
            count: results.length,
            note: "Henvis alltid til 'title' og 'source_url' i svar til brukeren.",
            results,
          },
          null,
          2
        ),
      },
    ],
  };
}

// ----------------------------------------------------------------
// doc_list
// ----------------------------------------------------------------
async function docList(args: Record<string, unknown>) {
  let query = supabase
    .from("documents")
    .select("title, category, year, publisher, municipality, page_count, file_type, ingested_at, source_url")
    .order("year", { ascending: false })
    .limit(50);

  if (args.category)     query = query.eq("category", args.category as string);
  if (args.municipality) query = query.ilike("municipality", `%${args.municipality}%`);
  if (args.year_from)    query = query.gte("year", args.year_from as number);
  if (args.year_to)      query = query.lte("year", args.year_to as number);

  const { data, error } = await query;
  if (error) throw new Error(`doc_list failed: ${error.message}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { count: data?.length ?? 0, documents: data },
          null,
          2
        ),
      },
    ],
  };
}

// ----------------------------------------------------------------
// doc_ingest  (triggers the ingest pipeline inline)
// ----------------------------------------------------------------
async function docIngest(args: Record<string, unknown>) {
  // Dynamically import to avoid loading heavy deps in MCP server startup
  const { ingestDocument } = await import("../../fetchers/documents");
  const fs = await import("fs");

  const filePath = args.file_path as string;
  if (!fs.existsSync(filePath)) {
    return {
      content: [{ type: "text", text: `File not found: ${filePath}` }],
      isError: true,
    };
  }

  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext !== "pdf" && ext !== "docx") {
    return {
      content: [{ type: "text", text: `Unsupported file type: .${ext}. Use PDF or DOCX.` }],
      isError: true,
    };
  }

  const buffer = fs.readFileSync(filePath);
  const driveId = (args.drive_id as string) ?? `local-${Date.now()}`;

  const result = await ingestDocument(
    {
      driveId,
      title:        args.title as string,
      sourceUrl:    (args.source_url as string) ?? filePath,
      category:     args.category as string,
      year:         args.year as number | undefined,
      publisher:    args.publisher as string | undefined,
      municipality: args.municipality as string | undefined,
      fileType:     ext as "pdf" | "docx",
    },
    buffer,
    (args.force_reingest as boolean) ?? false
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: "done",
            document_id: result.documentId,
            chunks_created: result.chunksCreated,
            message: result.chunksCreated === 0
              ? "Already ingested. Use force_reingest: true to re-process."
              : `Successfully ingested ${result.chunksCreated} chunks.`,
          },
          null,
          2
        ),
      },
    ],
  };
}
