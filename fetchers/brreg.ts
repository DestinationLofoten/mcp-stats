/**
 * fetchers/brreg.ts
 *
 * Fetches company info (Enhetsregisteret) + financial accounts
 * (Regnskapsregisteret) for a given municipality and year, then
 * upserts into Supabase.
 *
 * Usage:
 *   npm run fetch:brreg                          # all 6 Lofoten municipalities, 2024
 *   npm run fetch:brreg -- --kommune=1865 --year=2024
 */

import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";
import { getSupabaseAdmin } from "../lib/supabase";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const supabase = getSupabaseAdmin();

const ENHETER_URL = "https://data.brreg.no/enhetsregisteret/api/enheter";
const REGNSKAP_URL = "https://data.brreg.no/regnskapsregisteret/regnskap";

// The 6 Lofoten municipalities
const LOFOTEN_KOMMUNER = [
  "1856", // Røst
  "1857", // Værøy
  "1859", // Flakstad
  "1860", // Vestvågøy
  "1865", // Vågan
  "1874", // Moskenes
];

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------
interface Enhet {
  organisasjonsnummer: string;
  navn: string;
  organisasjonsform?: { kode: string; beskrivelse: string };
  naeringskode1?: { kode: string; beskrivelse: string };
  antallAnsatte?: number;
  forretningsadresse?: {
    kommune: string;
    kommunenummer: string;
    fylke: string;
  };
}

interface EnheterResponse {
  _embedded?: { enheter: Enhet[] };
  page: { totalPages: number; totalElements: number };
}

interface Regnskap {
  valuta?: string;
  eiendeler?: {
    sumEiendeler?: number;
    omloepsmidler?: { sumOmloepsmidler?: number };
  };
  egenkapitalGjeld?: {
    egenkapital?: { sumEgenkapital?: number };
    gjeldOversikt?: {
      kortsiktigGjeld?: { sumKortsiktigGjeld?: number };
      langsiktigGjeld?: { sumLangsiktigGjeld?: number };
    };
  };
  resultatregnskapResultat?: {
    ordinaertResultatFoerSkattekostnad?: number;
    aarsresultat?: number;
    driftsresultat?: {
      driftsinntekter?: { sumDriftsinntekter?: number };
      driftskostnad?: {
        sumDriftskostnad?: number;
        loennskostnad?: number;
      };
    };
  };
}

// ----------------------------------------------------------------
// Fetch all companies in a municipality (paginated)
// ----------------------------------------------------------------
async function fetchAllEnheter(kommunenummer: string): Promise<Enhet[]> {
  const all: Enhet[] = [];
  let page = 0;

  while (true) {
    // Filter on business address only: the generic `kommunenummer` param also
    // matches postal address, pulling in bankruptcy estates administered from
    // elsewhere and entities with no business address at all.
    const { data } = await axios.get<EnheterResponse>(ENHETER_URL, {
      params: {
        "forretningsadresse.kommunenummer": kommunenummer,
        page,
        size: 100,
      },
      headers: { Accept: "application/json" },
    });

    const enheter = data._embedded?.enheter ?? [];
    all.push(...enheter);
    console.log(
      `   📋 Page ${page + 1}/${data.page.totalPages}: ${enheter.length} companies`
    );

    if (page + 1 >= data.page.totalPages) break;
    page++;
    await new Promise((r) => setTimeout(r, 200));
  }

  return all;
}

// ----------------------------------------------------------------
// Fetch accounts for one org number and year
// ----------------------------------------------------------------
async function fetchRegnskap(
  orgNr: string,
  year: number
): Promise<Regnskap | null> {
  try {
    const { data } = await axios.get<Regnskap[]>(
      `${REGNSKAP_URL}/${orgNr}`,
      {
        params: { år: year, regnskapstype: "SELSKAP" },
        headers: { Accept: "application/json" },
        timeout: 10000,
      }
    );
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 404) return null;
      // Brreg returns 500 for unsupported accounting formats (e.g. IDEELL)
      if (status === 500) return null;
    }
    throw err;
  }
}

// ----------------------------------------------------------------
// Run up to `concurrency` promises at a time
// ----------------------------------------------------------------
async function pooled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------
async function fetchKommune(kommunenummer: string, year: number) {
  console.log(
    `🏢 Brreg fetcher — kommune ${kommunenummer}, year ${year}`
  );

  // Step 1: all companies in municipality
  console.log("\n📋 Fetching companies from Enhetsregisteret...");
  const enheter = await fetchAllEnheter(kommunenummer);
  console.log(`   ✅ ${enheter.length} companies found`);

  // Step 2: fetch accounts concurrently (10 at a time)
  console.log(
    `\n💰 Fetching ${year} accounts from Regnskapsregisteret...`
  );
  let withAccounts = 0;
  const fetchedAt = new Date().toISOString();

  const rows = await pooled(enheter, 10, async (e) => {
    const r = await fetchRegnskap(e.organisasjonsnummer, year);
    if (r) withAccounts++;

    const res = r?.resultatregnskapResultat;
    const drift = res?.driftsresultat;

    return {
      org_number: e.organisasjonsnummer,
      accounting_year: year,
      company_name: e.navn,
      org_form_code: e.organisasjonsform?.kode ?? null,
      org_form_desc: e.organisasjonsform?.beskrivelse ?? null,
      nace_code: e.naeringskode1?.kode ?? null,
      nace_desc: e.naeringskode1?.beskrivelse ?? null,
      municipality: e.forretningsadresse?.kommune ?? null,
      municipality_number: e.forretningsadresse?.kommunenummer ?? null,
      county: e.forretningsadresse?.fylke ?? null,
      employees: e.antallAnsatte ?? null,
      has_accounts: r !== null,
      currency: r?.valuta ?? null,
      // Income statement
      revenue:
        drift?.driftsinntekter?.sumDriftsinntekter ?? null,
      operating_costs:
        drift?.driftskostnad?.sumDriftskostnad ?? null,
      payroll_costs:
        drift?.driftskostnad?.loennskostnad ?? null,
      result_before_tax:
        res?.ordinaertResultatFoerSkattekostnad ?? null,
      annual_result: res?.aarsresultat ?? null,
      // Balance sheet
      total_assets:
        r?.eiendeler?.sumEiendeler ?? null,
      current_assets:
        r?.eiendeler?.omloepsmidler?.sumOmloepsmidler ?? null,
      short_term_debt:
        r?.egenkapitalGjeld?.gjeldOversikt?.kortsiktigGjeld
          ?.sumKortsiktigGjeld ?? null,
      long_term_debt:
        r?.egenkapitalGjeld?.gjeldOversikt?.langsiktigGjeld
          ?.sumLangsiktigGjeld ?? null,
      equity:
        r?.egenkapitalGjeld?.egenkapital?.sumEgenkapital ?? null,
      fetched_at: fetchedAt,
    };
  });

  console.log(
    `   ✅ ${withAccounts}/${enheter.length} companies have ${year} accounts`
  );

  // Step 3: upsert in batches of 500
  console.log("\n💾 Upserting to Supabase...");
  const batchSize = 500;
  let upserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from("brreg_companies")
      .upsert(batch, { onConflict: "org_number,accounting_year" });

    if (error) throw new Error(`Upsert failed: ${error.message}`);
    upserted += batch.length;
    console.log(`   ✅ ${upserted}/${rows.length} rows upserted`);
  }

  console.log(
    `\n✅ Kommune ${kommunenummer} complete — ${upserted} companies, ${withAccounts} with accounts.`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const kommuneArg = args.find((a) => a.startsWith("--kommune="))?.split("=")[1];
  const year = parseInt(
    args.find((a) => a.startsWith("--year="))?.split("=")[1] ?? "2024"
  );

  const kommuner = kommuneArg ? [kommuneArg] : LOFOTEN_KOMMUNER;

  for (const kommunenummer of kommuner) {
    await fetchKommune(kommunenummer, year);
  }

  console.log(
    `\n✅ Brreg fetch complete — ${kommuner.length} municipality(ies), year ${year}.`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
