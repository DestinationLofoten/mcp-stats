/**
 * mcp-server/tools/brreg-tools.ts
 *
 * MCP tools for querying Brønnøysundregistrene data from Supabase.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { supabase } from "../../lib/supabase";

// ----------------------------------------------------------------
// Tool definitions (what Claude sees)
// ----------------------------------------------------------------
export const brregTools: Tool[] = [
  {
    name: "brreg_search_companies",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Search companies in Lofoten (Vågan, Vestvågøy, Flakstad, Moskenes, Røst, Værøy) from Brønnøysundregistrene. Filter by name, NACE industry code, or company type. Returns company details including financial data (revenue, costs, profit, assets, equity) for a given accounting year.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Search by company name (partial match, case-insensitive)",
        },
        municipality: {
          type: "string",
          description: "Filter by municipality name (e.g. 'Svolvær', 'Kabelvåg')",
        },
        nace_code: {
          type: "string",
          description: "Filter by NACE industry code prefix (e.g. '55' for accommodation, '56' for food service)",
        },
        org_form: {
          type: "string",
          description: "Filter by company type code: AS, ENK, ANS, SA, etc.",
        },
        accounting_year: {
          type: "number",
          description: "Accounting year to return financials for (default: 2024)",
        },
        has_accounts: {
          type: "boolean",
          description: "If true, only return companies with financial accounts",
        },
        order_by: {
          type: "string",
          enum: ["revenue", "operating_costs", "annual_result", "total_assets", "equity", "employees", "company_name"],
          description: "Sort results by this field (descending). Default: company_name ascending",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 20, max: 100)",
        },
      },
    },
  },
  {
    name: "brreg_company_stats",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Get aggregate statistics about companies in Lofoten (Vågan, Vestvågøy, Flakstad, Moskenes, Røst, Værøy): counts and financial totals grouped by municipality, industry (NACE), or company type. Useful for overview reports and comparisons.",
    inputSchema: {
      type: "object",
      properties: {
        group_by: {
          type: "string",
          enum: ["municipality", "nace_desc", "org_form_desc"],
          description: "Dimension to group by",
        },
        accounting_year: {
          type: "number",
          description: "Accounting year for financial aggregates (default: 2024)",
        },
        limit: {
          type: "number",
          description: "Max groups to return (default: 20)",
        },
      },
      required: ["group_by"],
    },
  },
  {
    name: "brreg_get_company",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Get full details for a specific company by organisation number, including all financial data.",
    inputSchema: {
      type: "object",
      properties: {
        org_number: {
          type: "string",
          description: "9-digit Norwegian organisation number",
        },
        accounting_year: {
          type: "number",
          description: "Accounting year (default: 2024)",
        },
      },
      required: ["org_number"],
    },
  },
];

// ----------------------------------------------------------------
// Tool handlers
// ----------------------------------------------------------------
export async function handleBrregTool(
  name: string,
  args: Record<string, unknown>
) {
  switch (name) {
    case "brreg_search_companies":
      return searchCompanies(args);
    case "brreg_company_stats":
      return companyStats(args);
    case "brreg_get_company":
      return getCompany(args);
    default:
      throw new Error(`Unknown brreg tool: ${name}`);
  }
}

const FINANCIAL_COLUMNS = [
  "org_number",
  "accounting_year",
  "company_name",
  "org_form_code",
  "org_form_desc",
  "nace_code",
  "nace_desc",
  "municipality",
  "county",
  "employees",
  "has_accounts",
  "currency",
  "revenue",
  "operating_costs",
  "payroll_costs",
  "result_before_tax",
  "annual_result",
  "total_assets",
  "current_assets",
  "short_term_debt",
  "long_term_debt",
  "equity",
].join(", ");

async function searchCompanies(args: Record<string, unknown>) {
  const limit = Math.min(Number(args.limit ?? 20), 100);
  const year = Number(args.accounting_year ?? 2024);
  const orderBy = args.order_by as string | undefined;

  let query = supabase
    .from("brreg_companies")
    .select(FINANCIAL_COLUMNS)
    .eq("accounting_year", year)
    .limit(limit);

  if (args.name) query = query.ilike("company_name", `%${args.name}%`);
  if (args.municipality) query = query.ilike("municipality", `%${args.municipality}%`);
  if (args.nace_code) query = query.ilike("nace_code", `${args.nace_code}%`);
  if (args.org_form) query = query.eq("org_form_code", args.org_form as string);
  if (args.has_accounts !== undefined) query = query.eq("has_accounts", args.has_accounts as boolean);

  if (orderBy) {
    query = query.order(orderBy, { ascending: false, nullsFirst: false });
  } else {
    query = query.order("company_name", { ascending: true });
  }

  const { data, error } = await query;
  if (error) throw new Error(`brreg_search_companies failed: ${error.message}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { accounting_year: year, count: data?.length ?? 0, companies: data },
          null,
          2
        ),
      },
    ],
  };
}

async function companyStats(args: Record<string, unknown>) {
  const groupBy = args.group_by as string;
  const year = Number(args.accounting_year ?? 2024);
  const limit = Number(args.limit ?? 20);

  const validColumns = ["municipality", "nace_desc", "org_form_desc"];
  if (!validColumns.includes(groupBy)) {
    throw new Error(`Invalid group_by: ${groupBy}. Must be one of: ${validColumns.join(", ")}`);
  }

  // Aggregate in Postgres: the Data API caps a single select at 1,000 rows,
  // and the table holds several thousand companies per year.
  const { data, error } = await supabase.rpc("brreg_company_stats", {
    p_group_by: groupBy,
    p_year: year,
    p_limit: limit,
  });

  if (error) throw new Error(`brreg_company_stats failed: ${error.message}`);

  const result = data as { total_groups: number; data: unknown[] };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { accounting_year: year, group_by: groupBy, total_groups: result.total_groups, data: result.data },
          null,
          2
        ),
      },
    ],
  };
}

async function getCompany(args: Record<string, unknown>) {
  const year = Number(args.accounting_year ?? 2024);

  const { data, error } = await supabase
    .from("brreg_companies")
    .select("*")
    .eq("org_number", args.org_number as string)
    .eq("accounting_year", year)
    .maybeSingle();

  if (error) throw new Error(`brreg_get_company failed: ${error.message}`);
  if (!data) {
    throw new Error(
      `brreg_get_company: no data found for org_number=${args.org_number}, year=${year}. ` +
      `Note: this database only contains companies registered in Lofoten (Vågan, Vestvågøy, Flakstad, Moskenes, Røst, Værøy).`
    );
  }

  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}
