/**
 * fetchers/ssb.ts
 *
 * Fetches statistical data from SSB (Statistics Norway) StatBank API
 * and upserts into Supabase.
 *
 * Tables fetched:
 *   - 14172: Overnattingar, etter region, måned og innkvarteringstype
 *   - 13185: Sysselsatte og bearbeidingsverdi for overnattingsvirksomhet
 *   - 14168: Omsetning og kapasitetsutnytting på hotell
 *   - 13470: Sysselsatte per 4. kvartal, etter næring (SN2007), år og region — Lofoten
 *   - 13926: Lønnstakere og jobber, etter næring (SN2007) og kvartal — Lofoten (reiselivsnæringane)
 *
 * Usage:
 *   npm run fetch:ssb
 */

import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";
import { getSupabaseAdmin } from "../lib/supabase";
const supabase = getSupabaseAdmin();

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const BASE_URL =
  process.env.SSB_BASE_URL || "https://data.ssb.no/api/v0";

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------
interface SSBTableConfig {
  tableId: string;
  title: string;
  description: string;
  unit: string;
  query: object;
  skipNulls?: boolean;
  mapRow: (
    variables: Record<string, string>,
    labels: Record<string, string>,
    value: number | null
  ) => {
    region: string;
    region_name: string;
    time_period: string;
    time_type: string;
    category: string | null;
    category_label: string | null;
    value: number | null;
    unit: string;
  };
}

// ----------------------------------------------------------------
// Table configs
// ----------------------------------------------------------------
const TABLES: SSBTableConfig[] = [
  {
    tableId: "14172",
    title: "Overnattingar etter region, måned og innkvarteringstype",
    description:
      "Tal på overnattingar etter region, innkvarteringstype og gjestane sitt heimland",
    unit: "overnattingar",
    query: {
      query: [
        {
          code: "Region",
          selection: { filter: "all", values: ["*"] },
        },
        {
          code: "InnKvartering1",
          selection: {
            filter: "item",
            values: ["01", "02+03+04"], // hotels + camping/cabin/hostel
          },
        },
        {
          code: "Landkoder2",
          selection: { filter: "all", values: ["*"] }, // all 75 markets
        },
        {
          code: "ContentsCode",
          selection: { filter: "item", values: ["Overnattinger"] },
        },
        {
          code: "Tid",
          selection: { filter: "top", values: ["120"] }, // last 120 months (~10 years)
        },
      ],
      response: { format: "json-stat2" },
    },
    mapRow: (vars, labels, value) => ({
      region: vars["Region"],
      region_name: labels["Region"] ?? vars["Region"],
      time_period: vars["Tid"],
      time_type: "month",
      // Encode both dimensions: accommodation type + country of origin
      category: `${vars["InnKvartering1"]}__${vars["Landkoder2"]}`,
      category_label: `${labels["InnKvartering1"] ?? vars["InnKvartering1"]} / ${labels["Landkoder2"] ?? vars["Landkoder2"]}`,
      value,
      unit: "overnattingar",
    }),
  },
  {
    tableId: "13185",
    title: "Sysselsette og bearbeidingsverdi for overnattingsverksemd",
    description:
      "Sysselsette, omsetning og bearbeidingsverdi for overnattingsverksemd etter region, år og næring (NACE)",
    unit: "mixed",
    query: {
      query: [
        {
          code: "Region",
          selection: { filter: "all", values: ["*"] },
        },
        {
          code: "NACE2007",
          selection: {
            filter: "item",
            values: ["55", "55.1", "55.2-55.3"],
          },
        },
        {
          code: "ContentsCode",
          selection: {
            filter: "item",
            values: ["Sysselsatte", "Omsetning", "BearbVerdi"],
          },
        },
        {
          code: "Tid",
          selection: { filter: "top", values: ["10"] }, // all available years (2015-2024)
        },
      ],
      response: { format: "json-stat2" },
    },
    mapRow: (vars, labels, value) => {
      const nace = labels["NACE2007"] ?? vars["NACE2007"];
      const contents = labels["ContentsCode"] ?? vars["ContentsCode"];
      return {
        region: vars["Region"],
        region_name: labels["Region"] ?? vars["Region"],
        time_period: vars["Tid"],
        time_type: "year",
        category: `${vars["NACE2007"]}__${vars["ContentsCode"]}`,
        category_label: `${nace} – ${contents}`,
        value,
        unit: vars["ContentsCode"] === "Sysselsatte" ? "personar" : "1 000 kr",
      };
    },
  },
  {
    tableId: "14168",
    title: "Omsetning og kapasitetsutnytting på hotell",
    description:
      "Utleigde rom, pris per rom, kapasitetsutnytting og losjiomsetning for hotell etter region og månad",
    unit: "mixed",
    query: {
      query: [
        {
          code: "Region",
          selection: { filter: "all", values: ["*"] },
        },
        {
          code: "ContentsCode",
          selection: {
            filter: "item",
            values: [
              "UtleigdeRom",
              "PrisRom",
              "KapasitetRom",
              "KapasitetSeng",
              "LosjiOms",
              "LosjiOmsRom",
            ],
          },
        },
        {
          code: "Tid",
          selection: { filter: "top", values: ["36"] }, // last 36 months
        },
      ],
      response: { format: "json-stat2" },
    },
    mapRow: (vars, labels, value) => {
      const contents = vars["ContentsCode"];
      const unitMap: Record<string, string> = {
        UtleigdeRom: "rom",
        PrisRom: "kr",
        KapasitetRom: "prosent",
        KapasitetSeng: "prosent",
        LosjiOms: "1 000 kr",
        LosjiOmsRom: "kr",
      };
      return {
        region: vars["Region"],
        region_name: labels["Region"] ?? vars["Region"],
        time_period: vars["Tid"],
        time_type: "month",
        category: contents,
        category_label: labels["ContentsCode"] ?? contents,
        value,
        unit: unitMap[contents] ?? "",
      };
    },
  },
  {
    tableId: "13470",
    title: "Sysselsatte per 4. kvartal etter næring — Lofoten",
    description:
      "Sysselsatte personar per 4. kvartal etter næring (SN2007) og år for Lofoten-kommunane: Vågan (1865), Vestvågøy (1860), Flakstad (1859), Moskenes (1874), Røst (1856) og Værøy (1857)",
    unit: "personar",
    skipNulls: true,
    query: {
      query: [
        {
          code: "Region",
          selection: { filter: "item", values: ["1865", "1860", "1859", "1874", "1856", "1857"] },
        },
        {
          code: "NACE2007",
          selection: { filter: "all", values: ["*"] },
        },
        {
          code: "ContentsCode",
          selection: {
            filter: "item",
            values: ["Sysselsatte", "SysselsatteArb"],
          },
        },
        {
          code: "Tid",
          selection: { filter: "all", values: ["*"] },
        },
      ],
      response: { format: "json-stat2" },
    },
    mapRow: (vars, labels, value) => {
      const nace = labels["NACE2007"] ?? vars["NACE2007"];
      const contents = labels["ContentsCode"] ?? vars["ContentsCode"];
      return {
        region: vars["Region"],
        region_name: labels["Region"] ?? vars["Region"],
        time_period: vars["Tid"],
        time_type: "year",
        category: `${vars["NACE2007"]}__${vars["ContentsCode"]}`,
        category_label: `${nace} – ${contents}`,
        value,
        unit: "personar",
      };
    },
  },
  {
    tableId: "13926",
    title: "Lønnstakere og jobber etter næring (reiselivsnæringane) — Lofoten",
    description:
      "Antal lønnstakere og jobber per kvartal etter reiselivsnæring (SN2007) for Lofoten-kommunane: Vågan (1865), Vestvågøy (1860), Flakstad (1859), Moskenes (1874), Røst (1856) og Værøy (1857). Næringane er gruppert etter NHO-modellen: Transport, Overnatting, Servering, Formidling og Opplevingar.",
    unit: "mixed",
    skipNulls: true,
    query: {
      query: [
        {
          code: "Region",
          selection: {
            filter: "item",
            values: ["1865", "1860", "1859", "1874", "1856", "1857"],
          },
        },
        {
          code: "Sektor",
          selection: { filter: "item", values: ["ALLE"] },
        },
        {
          code: "NACE2007",
          selection: {
            filter: "item",
            values: [
              // Servering (detaljhandel)
              "47.241",
              // Transport
              "49.100", "49.311", "49.312", "49.320", "49.391", "49.392", "49.393",
              "50.101", "50.102", "50.109", "50.300", "51.100",
              // Overnatting
              "55.101", "55.102", "55.201", "55.202", "55.300", "55.301", "55.302",
              // Servering
              "56.101", "56.102", "56.210", "56.301", "56.309",
              // Formidling
              "77.210", "79.110", "79.120", "79.901", "79.902", "79.903", "79.909",
              // Opplevingar
              "59.140", "90.012", "90.020", "90.040",
              "91.021", "91.022", "91.023", "91.029", "91.030", "91.040",
              "93.210", "93.291", "93.292",
            ],
          },
        },
        {
          code: "ContentsCode",
          selection: { filter: "item", values: ["AntLonnstakere", "AntJobber"] },
        },
        {
          code: "Tid",
          selection: { filter: "all", values: ["*"] },
        },
      ],
      response: { format: "json-stat2" },
    },
    mapRow: (vars, labels, value) => {
      const nace = labels["NACE2007"] ?? vars["NACE2007"];
      const contents = labels["ContentsCode"] ?? vars["ContentsCode"];
      const unitMap: Record<string, string> = {
        AntLonnstakere: "lønnstakere",
        AntJobber: "jobber",
      };
      return {
        region: vars["Region"],
        region_name: labels["Region"] ?? vars["Region"],
        time_period: vars["Tid"],
        time_type: "quarter",
        category: `${vars["ContentsCode"]}__${vars["NACE2007"]}`,
        category_label: `${contents} – ${nace}`,
        value,
        unit: unitMap[vars["ContentsCode"]] ?? "ukjent",
      };
    },
  },
];

// ----------------------------------------------------------------
// JSON-stat2 parser
// ----------------------------------------------------------------
interface JSONStat2 {
  dimension: Record<
    string,
    {
      label: string;
      category: {
        index: Record<string, number>;
        label: Record<string, string>;
      };
    }
  >;
  value: (number | null)[];
  id: string[];
  size: number[];
}

function* iterateJSONStat(data: JSONStat2): Generator<{
  variables: Record<string, string>;
  labels: Record<string, string>;
  value: number | null;
}> {
  const dims = data.id;
  const sizes = data.size;

  const categories = dims.map((dimId) => {
    const dim = data.dimension[dimId];
    return Object.entries(dim.category.index)
      .sort(([, a], [, b]) => a - b)
      .map(([code]) => ({ code, label: dim.category.label[code] }));
  });

  const total = sizes.reduce((a, b) => a * b, 1);
  for (let i = 0; i < total; i++) {
    const variables: Record<string, string> = {};
    const labels: Record<string, string> = {};
    let remainder = i;

    for (let d = dims.length - 1; d >= 0; d--) {
      const idx = remainder % sizes[d];
      remainder = Math.floor(remainder / sizes[d]);
      variables[dims[d]] = categories[d][idx].code;
      labels[dims[d]] = categories[d][idx].label;
    }

    yield { variables, labels, value: data.value[i] };
  }
}

// ----------------------------------------------------------------
// Fetch and store one SSB table
// ----------------------------------------------------------------
async function fetchSSBTable(config: SSBTableConfig) {
  console.log(`\n📊 Fetching SSB table ${config.tableId}: ${config.title}`);

  const { data: dataset, error: dsErr } = await supabase
    .from("ssb_datasets")
    .upsert(
      {
        table_id: config.tableId,
        title: config.title,
        description: config.description,
        unit: config.unit,
        source_url: `${BASE_URL}/no/table/${config.tableId}`,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "table_id" }
    )
    .select("id")
    .single();

  if (dsErr || !dataset) {
    throw new Error(`Failed to upsert dataset: ${dsErr?.message}`);
  }

  const url = `${BASE_URL}/no/table/${config.tableId}`;
  const response = await axios.post<JSONStat2>(url, config.query, {
    headers: { "Content-Type": "application/json" },
  });

  const jsonstat = response.data;
  const rows: object[] = [];

  for (const { variables, labels, value } of iterateJSONStat(jsonstat)) {
    if (config.skipNulls && value === null) continue;
    const mapped = config.mapRow(variables, labels, value);
    rows.push({
      dataset_id: dataset.id,
      ...mapped,
      fetched_at: new Date().toISOString(),
    });
  }

  // Delete all existing observations for this dataset before reinserting.
  // Uses a SECURITY DEFINER RPC so the delete runs server-side without client statement timeout.
  console.log(`   🗑️  Clearing old observations...`);
  const { error: delErr } = await supabase.rpc("clear_ssb_dataset", {
    p_dataset_id: dataset.id,
  });
  if (delErr) throw new Error(`Failed to clear dataset: ${delErr.message}`);

  const batchSize = 1000;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from("ssb_observations").insert(batch);

    if (error) {
      console.error(`   ❌ Insert error at batch ${i}: ${error.message}`);
      throw error;
    }

    inserted += batch.length;
    console.log(`   ✅ Inserted ${inserted}/${rows.length} observations`);
  }

  console.log(`   ✅ Table ${config.tableId} complete — ${rows.length} rows`);
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------
async function refreshMaterializedViews() {
  console.log("\n🔄 Refreshing materialized views...");
  const { error } = await supabase.rpc("refresh_ssb_overnights_view" as never);
  if (error) {
    // Fallback: log the error but don't crash — the view will be stale until next run
    console.warn(`   ⚠️  Could not refresh view via RPC: ${error.message}`);
    console.warn("   Run manually: REFRESH MATERIALIZED VIEW ssb_overnights_by_market;");
  } else {
    console.log("   ✅ ssb_overnights_by_market refreshed");
  }
}

async function main() {
  console.log("📈 SSB fetcher starting...");

  for (const table of TABLES) {
    await fetchSSBTable(table);
    await new Promise((r) => setTimeout(r, 500));
  }

  await refreshMaterializedViews();

  console.log("\n✅ SSB fetch complete.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
