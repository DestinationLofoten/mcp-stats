/**
 * mcp-server/tools/ssb-tools.ts
 *
 * MCP tools for querying SSB (Statistics Norway) data from Supabase.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { supabase } from "../../lib/supabase";

// ----------------------------------------------------------------
// Tool definitions
// ----------------------------------------------------------------
export const ssbTools: Tool[] = [
  {
    name: "ssb_list_datasets",
    description:
      "List all SSB statistical datasets available in the database, with their table IDs and descriptions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ssb_get_observations",
    description:
      "Get statistical observations from a specific SSB dataset. Filter by region, time period, or category. Use ssb_list_datasets first to find available table IDs.",
    inputSchema: {
      type: "object",
      properties: {
        table_id: {
          type: "string",
          description: "SSB table ID (e.g. '07459' for population data)",
        },
        region: {
          type: "string",
          description: "Filter by region/municipality name or code",
        },
        time_period: {
          type: "string",
          description:
            "Filter by specific year or period (e.g. '2023', '2023M01')",
        },
        time_from: {
          type: "string",
          description: "Filter observations from this period onwards (inclusive)",
        },
        category: {
          type: "string",
          description: "Filter by category label (partial match). For table 14172, category encodes both accommodation type and country, e.g. 'Hotell' or 'Norge' or 'Germany'.",
        },
        accommodation_type: {
          type: "string",
          enum: ["01", "02+03+04"],
          description: "For table 14172: filter by accommodation type. '01' = hotels, '02+03+04' = camping/cabins/hostels.",
        },
        country_code: {
          type: "string",
          description: "For table 14172: filter by country of origin code (e.g. '000' = Norway, '144' = Germany, '139' = UK, '684' = USA, '117' = France, '00000' = total all countries, 'ccc' = all foreign).",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 200). For table 14172 with both accommodation types and all countries, use at least 200 to avoid missing combinations.",
        },
        order_by: {
          type: "string",
          enum: ["time_period", "value", "region_name"],
          description: "Sort results by this field (default: time_period)",
        },
        order_desc: {
          type: "boolean",
          description: "Sort descending (default: true)",
        },
      },
      required: ["table_id"],
    },
  },
  {
    name: "ssb_compare_regions",
    description:
      "Compare a statistical measure across multiple regions for the most recent available time period. Great for generating regional comparison reports.",
    inputSchema: {
      type: "object",
      properties: {
        table_id: {
          type: "string",
          description: "SSB table ID to query",
        },
        regions: {
          type: "array",
          items: { type: "string" },
          description:
            "List of region names or codes to compare. Leave empty to get all regions.",
        },
        time_period: {
          type: "string",
          description: "Time period to compare (defaults to most recent)",
        },
      },
      required: ["table_id"],
    },
  },
  {
    name: "ssb_time_series",
    description:
      "Get a time series of observations for one or more regions, useful for trend analysis and reports showing change over time.",
    inputSchema: {
      type: "object",
      properties: {
        table_id: {
          type: "string",
          description: "SSB table ID",
        },
        region: {
          type: "string",
          description: "Region name or code to get time series for",
        },
        limit: {
          type: "number",
          description: "Number of time periods (default: 10, most recent first)",
        },
      },
      required: ["table_id", "region"],
    },
  },
  {
    name: "ssb_employment_by_industry",
    description:
      "Get employment figures (sysselsatte) per 4th quarter by industry (næring/NACE2007) for Lofoten municipalities, from SSB table 13470. Covers Vågan (1865), Vestvågøy (1860), Flakstad (1859), Moskenes (1874), Røst (1856) and Værøy (1857). Data covers 2008–present. Use this to analyse which industries employ people in Lofoten, compare municipalities, and see how the tourism sector relates to others. The 'contents_type' parameter switches between people counted by residence (bosted) or by workplace (arbeidssted) — prefer arbeidssted for understanding actual local employment footprint.",
    inputSchema: {
      type: "object",
      properties: {
        nace_code: {
          type: "string",
          description: "Filter by NACE2007 code or partial code (e.g. '55' for accommodation, '56' for food service, '00-99' for all industries total)",
        },
        nace_label: {
          type: "string",
          description: "Filter by næring label, partial match (e.g. 'hotell', 'fiske', 'varehandel')",
        },
        year: {
          type: "string",
          description: "Filter by specific year (e.g. '2024')",
        },
        year_from: {
          type: "string",
          description: "Filter from this year onwards (e.g. '2018')",
        },
        contents_type: {
          type: "string",
          enum: ["Sysselsatte", "SysselsatteArb"],
          description: "Which employment count to return: 'Sysselsatte' = by residence (bosted), 'SysselsatteArb' = by workplace (arbeidssted). Default: both.",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 100)",
        },
        order_by: {
          type: "string",
          enum: ["value", "time_period", "category_label"],
          description: "Sort field (default: value)",
        },
        order_desc: {
          type: "boolean",
          description: "Sort descending (default: true)",
        },
      },
    },
  },
  {
    name: "ssb_wage_earners_by_industry",
    description:
      "Get quarterly wage earners (lønnstakere) and jobs (jobber) by tourism industry for Lofoten municipalities, from SSB table 13926. Covers Vågan (1865), Vestvågøy (1860), Flakstad (1859), Moskenes (1874), Røst (1856) and Værøy (1857). Industries follow the NHO tourism model: 'transport', 'overnatting', 'servering', 'formidling', 'opplevingar'. Use this to analyse seasonal variation (quarterly), compare municipalities, and track employment trends in the tourism sector. Note: lønnstakere = wage earners (individuals), jobber = jobs (including multiple jobs per person).",
    inputSchema: {
      type: "object",
      properties: {
        municipality: {
          type: "string",
          description: "Filter by municipality name or code (e.g. 'Vågan', '1865')",
        },
        tourism_group: {
          type: "string",
          enum: ["transport", "overnatting", "servering", "formidling", "opplevingar"],
          description: "Filter by NHO tourism category group",
        },
        nace_code: {
          type: "string",
          description: "Filter by specific NACE2007 code (e.g. '55.101')",
        },
        contents_type: {
          type: "string",
          enum: ["AntLonnstakere", "AntJobber"],
          description: "Which measure: 'AntLonnstakere' = wage earners, 'AntJobber' = jobs. Default: both.",
        },
        quarter: {
          type: "string",
          description: "Filter by specific quarter (e.g. '2024K3')",
        },
        quarter_from: {
          type: "string",
          description: "Filter from this quarter onwards (e.g. '2020K1')",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 500)",
        },
        order_by: {
          type: "string",
          enum: ["value", "time_period", "region_name", "category_label"],
          description: "Sort field (default: time_period)",
        },
        order_desc: {
          type: "boolean",
          description: "Sort descending (default: true)",
        },
      },
    },
  },
  {
    name: "ssb_overnights_by_market",
    description:
      "Get overnight stay totals by visitor market (country of origin) for any Norwegian tourism region and time period. Data is pre-aggregated across all accommodation types (hotels + camping/cabins/hostels combined). Use this for all market ranking, share analysis, and country-level comparisons — it is more reliable than ssb_get_observations for this purpose. Country codes: '000'=Norway, '00000'=all countries total, 'ccc'=all foreign total. Rows with null values (SSB-suppressed data below reporting threshold) are excluded by default. IMPORTANT: When asking about a specific country (e.g. 'Kina', 'USA'), always pass the `country` parameter — without it, the default limit sorted by total_overnights will cut off small markets and you may incorrectly conclude data is missing. If the response includes truncated: true, refine your query or increase the limit.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Filter by region name or code (e.g. 'Lofoten', 'Nordland', '18105')",
        },
        time_period: {
          type: "string",
          description: "Filter by specific month (e.g. '2025M12')",
        },
        time_from: {
          type: "string",
          description: "Filter from this month onwards (e.g. '2024M01')",
        },
        country: {
          type: "string",
          description: "Filter by country name, partial match (e.g. 'Kina', 'Norge', 'Tyskland')",
        },
        exclude_aggregates: {
          type: "boolean",
          description: "Exclude aggregate rows (total all countries '00000' and total foreign 'ccc'). Default: true.",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 100)",
        },
        order_by: {
          type: "string",
          enum: ["total_overnights", "time_period", "country_label", "region_name"],
          description: "Sort field (default: total_overnights)",
        },
        order_desc: {
          type: "boolean",
          description: "Sort descending (default: true)",
        },
      },
    },
  },
];

// ----------------------------------------------------------------
// Tool handlers
// ----------------------------------------------------------------
export async function handleSsbTool(
  name: string,
  args: Record<string, unknown>
) {
  switch (name) {
    case "ssb_list_datasets":
      return listDatasets();
    case "ssb_get_observations":
      return getObservations(args);
    case "ssb_employment_by_industry":
      return employmentByIndustry(args);
    case "ssb_wage_earners_by_industry":
      return wageEarnersByIndustry(args);
    case "ssb_overnights_by_market":
      return overnightsByMarket(args);
    case "ssb_compare_regions":
      return compareRegions(args);
    case "ssb_time_series":
      return timeSeries(args);
    default:
      throw new Error(`Unknown SSB tool: ${name}`);
  }
}

async function listDatasets() {
  const { data, error } = await supabase
    .from("ssb_datasets")
    .select("table_id, title, description, unit, fetched_at")
    .order("table_id");

  if (error) throw new Error(`ssb_list_datasets failed: ${error.message}`);

  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

async function getObservations(args: Record<string, unknown>) {
  const limit = Math.min(Number(args.limit ?? 200), 500);
  const orderBy = (args.order_by as string) ?? "time_period";
  const orderDesc = args.order_desc !== false;

  // Get dataset id
  const { data: dataset, error: dsErr } = await supabase
    .from("ssb_datasets")
    .select("id, title, unit")
    .eq("table_id", args.table_id as string)
    .single();

  if (dsErr || !dataset) throw new Error(`Dataset ${args.table_id} not found`);

  let query = supabase
    .from("ssb_observations")
    .select("region, region_name, time_period, category_label, value, unit")
    .eq("dataset_id", dataset.id)
    .order(orderBy, { ascending: !orderDesc })
    .limit(limit);

  if (args.region)
    query = query.or(
      `region.ilike.%${args.region}%,region_name.ilike.%${args.region}%`
    );
  if (args.time_period) query = query.eq("time_period", args.time_period as string);
  if (args.time_from) query = query.gte("time_period", args.time_from as string);
  if (args.category)
    query = query.ilike("category_label", `%${args.category}%`);
  if (args.accommodation_type)
    query = query.ilike("category", `${args.accommodation_type}__%`);
  if (args.country_code)
    query = query.ilike("category", `%__${args.country_code}`);

  const { data, error } = await query;
  if (error) throw new Error(`ssb_get_observations failed: ${error.message}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            dataset: { table_id: args.table_id, title: dataset.title, unit: dataset.unit },
            count: data?.length,
            observations: data,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function compareRegions(args: Record<string, unknown>) {
  const { data: dataset, error: dsErr } = await supabase
    .from("ssb_datasets")
    .select("id, title, unit")
    .eq("table_id", args.table_id as string)
    .single();

  if (dsErr || !dataset) throw new Error(`Dataset ${args.table_id} not found`);

  // Find most recent time period if not specified
  let timePeriod = args.time_period as string | undefined;
  if (!timePeriod) {
    const { data: latest } = await supabase
      .from("ssb_observations")
      .select("time_period")
      .eq("dataset_id", dataset.id)
      .order("time_period", { ascending: false })
      .limit(1)
      .single();

    timePeriod = latest?.time_period;
  }

  let query = supabase
    .from("ssb_observations")
    .select("region, region_name, time_period, value, unit")
    .eq("dataset_id", dataset.id)
    .eq("time_period", timePeriod!)
    .order("value", { ascending: false });

  const regions = args.regions as string[] | undefined;
  if (regions && regions.length > 0) {
    // Filter by any of the listed regions
    query = query.in("region_name", regions);
  }

  const { data, error } = await query;
  if (error) throw error;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            dataset: { table_id: args.table_id, title: dataset.title },
            time_period: timePeriod,
            comparison: data,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function timeSeries(args: Record<string, unknown>) {
  const { data: dataset, error: dsErr } = await supabase
    .from("ssb_datasets")
    .select("id, title, unit")
    .eq("table_id", args.table_id as string)
    .single();

  if (dsErr || !dataset) throw new Error(`Dataset ${args.table_id} not found`);

  const limit = Number(args.limit ?? 10);

  const { data, error } = await supabase
    .from("ssb_observations")
    .select("region, region_name, time_period, value, unit")
    .eq("dataset_id", dataset.id)
    .or(
      `region.ilike.%${args.region}%,region_name.ilike.%${args.region}%`
    )
    .order("time_period", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const sorted = [...(data ?? [])].sort((a, b) =>
    a.time_period.localeCompare(b.time_period)
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            dataset: { table_id: args.table_id, title: dataset.title, unit: dataset.unit },
            region: args.region,
            time_series: sorted,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function employmentByIndustry(args: Record<string, unknown>) {
  const limit = Math.min(Number(args.limit ?? 100), 1000);
  const orderBy = (args.order_by as string) ?? "value";
  const orderDesc = args.order_desc !== false;

  const { data: dataset, error: dsErr } = await supabase
    .from("ssb_datasets")
    .select("id, title, unit")
    .eq("table_id", "13470")
    .single();

  if (dsErr || !dataset) throw new Error("SSB table 13470 not found in database");

  let query = supabase
    .from("ssb_observations")
    .select("region_name, time_period, category, category_label, value, unit")
    .eq("dataset_id", dataset.id)
    .order(orderBy, { ascending: !orderDesc })
    .limit(limit);

  if (args.nace_code)
    query = query.ilike("category", `${args.nace_code}__%`);
  if (args.nace_label)
    query = query.ilike("category_label", `%${args.nace_label}%`);
  if (args.year)
    query = query.eq("time_period", args.year as string);
  if (args.year_from)
    query = query.gte("time_period", args.year_from as string);
  if (args.contents_type)
    query = query.ilike("category", `%__${args.contents_type}`);

  const { data, error } = await query;
  if (error) throw new Error(`ssb_employment_by_industry failed: ${error.message}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            dataset: { table_id: "13470", title: dataset.title },
            region: "Lofoten: Vågan (1865), Vestvågøy (1860), Flakstad (1859), Moskenes (1874), Røst (1856), Værøy (1857)",
            note: "category_label format: '<næring> – <Sysselsatte etter bosted|arbeidssted>'",
            count: data?.length,
            observations: data,
          },
          null,
          2
        ),
      },
    ],
  };
}

const TOURISM_GROUP_PREFIXES: Record<string, string[]> = {
  transport:    ["49.1", "49.3", "50.1", "50.3", "51."],
  overnatting:  ["55."],
  servering:    ["47.241", "56."],
  formidling:   ["77.210", "79."],
  opplevingar:  ["59.1", "90.", "91.", "93."],
};

function tourismGroupLabel(nace: string): string {
  for (const [group, prefixes] of Object.entries(TOURISM_GROUP_PREFIXES)) {
    if (prefixes.some((p) => nace.startsWith(p))) return group;
  }
  return "annet";
}

async function wageEarnersByIndustry(args: Record<string, unknown>) {
  const limit = Math.min(Number(args.limit ?? 500), 2000);
  const orderBy = (args.order_by as string) ?? "time_period";
  const orderDesc = args.order_desc !== false;

  const { data: dataset, error: dsErr } = await supabase
    .from("ssb_datasets")
    .select("id, title")
    .eq("table_id", "13926")
    .single();

  if (dsErr || !dataset) throw new Error("SSB table 13926 not found — run fetch:ssb first");

  let query = supabase
    .from("ssb_observations")
    .select("region, region_name, time_period, category, category_label, value, unit")
    .eq("dataset_id", dataset.id)
    .order(orderBy, { ascending: !orderDesc })
    .limit(limit);

  if (args.municipality)
    query = query.or(
      `region.ilike.%${args.municipality}%,region_name.ilike.%${args.municipality}%`
    );
  if (args.quarter)
    query = query.eq("time_period", args.quarter as string);
  if (args.quarter_from)
    query = query.gte("time_period", args.quarter_from as string);
  if (args.contents_type)
    query = query.ilike("category", `${args.contents_type}__%`);
  if (args.nace_code)
    query = query.ilike("category", `%__${args.nace_code}`);

  if (args.tourism_group) {
    const prefixes = TOURISM_GROUP_PREFIXES[args.tourism_group as string] ?? [];
    const orClauses = prefixes.map((p) => `category.ilike.%__${p}%`).join(",");
    if (orClauses) query = query.or(orClauses);
  }

  const { data, error } = await query;
  if (error) throw new Error(`ssb_wage_earners_by_industry failed: ${error.message}`);

  const rows = (data ?? []).map((row) => {
    const nace = (row.category as string).split("__")[1] ?? "";
    return { ...row, tourism_group: tourismGroupLabel(nace) };
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            dataset: { table_id: "13926", title: dataset.title },
            note: "category format: '<AntLonnstakere|AntJobber>__<NACE2007>'. tourism_group follows NHO model.",
            municipalities: "Vågan (1865), Vestvågøy (1860), Flakstad (1859), Moskenes (1874), Røst (1856), Værøy (1857)",
            count: rows.length,
            observations: rows,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function overnightsByMarket(args: Record<string, unknown>) {
  const limit = Math.min(Number(args.limit ?? 100), 500);
  const orderBy = (args.order_by as string) ?? "total_overnights";
  const orderDesc = args.order_desc !== false;
  const excludeAggregates = args.exclude_aggregates !== false;

  let query = supabase
    .from("ssb_overnights_by_market")
    .select("region, region_name, time_period, country_code, country_label, total_overnights, unit")
    .order(orderBy, { ascending: !orderDesc })
    .limit(limit);

  if (args.region)
    query = query.or(`region.ilike.%${args.region}%,region_name.ilike.%${args.region}%`);
  if (args.time_period)
    query = query.eq("time_period", args.time_period as string);
  if (args.time_from)
    query = query.gte("time_period", args.time_from as string);
  if (args.country)
    query = query.ilike("country_label", `%${args.country}%`);
  if (excludeAggregates)
    query = query.neq("country_code", "00000").neq("country_code", "ccc");

  // Exclude rows where SSB suppressed the value (null = confidential / below threshold)
  query = query.not("total_overnights", "is", null);

  const { data, error } = await query;
  if (error) throw new Error(`ssb_overnights_by_market query failed: ${error.message ?? JSON.stringify(error)}`);

  // Coerce total_overnights to number (view may return it as string from numeric SUM)
  const markets = (data ?? []).map((row) => ({
    ...row,
    total_overnights: row.total_overnights == null ? null : Number(row.total_overnights),
  }));

  const truncated = markets.length === limit;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            note: "Totals are pre-aggregated across all accommodation types (hotels + camping/cabins/hostels).",
            count: markets.length,
            truncated,
            truncated_warning: truncated
              ? `Result is capped at ${limit} rows. Data may be incomplete — use the 'country' filter or increase 'limit' to avoid missing markets.`
              : undefined,
            markets,
          },
          null,
          2
        ),
      },
    ],
  };
}
