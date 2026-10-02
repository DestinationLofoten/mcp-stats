/**
 * fetchers/sync-drive.ts
 *
 * Syncs Google Drive folders → Supabase RAG (documents + document_chunks).
 * Uses googleapis with OAuth2 Desktop credentials.
 *
 * FIRST-TIME SETUP:
 *   1. Add to .env:
 *        GOOGLE_CLIENT_ID=<your-client-id>
 *        GOOGLE_CLIENT_SECRET=<your-client-secret>
 *   2. Run: npm run sync:drive:auth   (one-time browser auth, saves .credentials/google.json)
 *   3. Run: npm run sync:drive        (download + ingest all new files)
 *
 * SUBSEQUENT RUNS:
 *   npm run sync:drive                (ingests every new file in the nordata-dokumenter
 *                                      folder tree; already-ingested files are skipped)
 *   npm run sync:drive -- --dry-run   (list what would be ingested, change nothing)
 *   npm run sync:drive -- --force     (re-ingest all files)
 *
 * See README for how to create Google Cloud OAuth2 Desktop credentials.
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as dotenv from "dotenv";
import { google, drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { ingestDocument } from "./documents";
import { getSupabaseAdmin } from "../lib/supabase";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const CREDENTIALS_PATH = path.resolve(__dirname, "../.credentials/google.json");
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

// ----------------------------------------------------------------
// Drive layout — everything under ROOT_FOLDER_ID is synced:
//   nordata-dokumenter/<category>/<municipality or publisher>/…/file.pdf
// The first folder level gives the category, the second the municipality.
// Supported files: PDF, Word (.docx) and Google Docs (exported as .docx).
// ----------------------------------------------------------------
const ROOT_FOLDER_ID = process.env.NORDATA_DRIVE_FOLDER_ID || "1u6BiOfkPXjMuCF2iJvBfaxupRcAWiZrg";

type Category = "strategi" | "rapport" | "plan" | "utredning" | "statistikk" | "annet";
const CATEGORIES: Category[] = ["strategi", "rapport", "plan", "utredning", "statistikk"];

// Second-level folder name (lowercased) → municipality/publisher.
// Unknown folders fall back to the folder name with "-kommune" stripped.
const FOLDER_META: Record<string, { municipality: string; publisher?: string }> = {
  "lofotrådet": { municipality: "Lofoten", publisher: "Lofotrådet" },
  "lofoten-de-grønne-øyene": { municipality: "Lofoten", publisher: "Lofoten – De Grønne Øyene" },
  "nordland fylke": { municipality: "Nordland", publisher: "Nordland fylkeskommune" },
};

// ----------------------------------------------------------------
// Per-file overrides — optional nicer titles/years/metadata, keyed by
// Drive ID. Files listed here are also synced even if they live outside
// ROOT_FOLDER_ID. Files without an entry get their title from the filename.
// ----------------------------------------------------------------
interface FileManifest {
  driveId: string;
  title: string;
  category?: Category;
  municipality?: string;
  publisher?: string;
  year?: number;
}

const OVERRIDES: FileManifest[] = [
  // ── strategi / Lofotrådet ────────────────────────────────────────
  {
    driveId: "1An5vhzJoQhV5hZ0eOPlHpIlKZ3Or0RvA",
    title: "Lofotrådet rullert strategi 2022-2033",
    category: "strategi",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2022,
  },
  // ── strategi / vestvågøy ────────────────────────────────────────
  {
    driveId: "111T9aSJJDQEng36m0y_dcact7w09wxdf",
    title: "Eiendomsstrategi 2019-2030 Vestvågøy kommune",
    category: "strategi",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
    year: 2019,
  },
  // ── rapport / lofotrådet — årsberetninger ───────────────────────
  {
    driveId: "1zLhv4qtEhXwoarZcfxbJC1Z57QAn_N9O",
    title: "Lofotrådet bidrag årsberetning 2012",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2012,
  },
  {
    driveId: "1_i2E93VS1jK7bsHdg8C8yUpaFySTvj7R",
    title: "Lofotrådet bidrag årsberetning 2013",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2013,
  },
  {
    driveId: "19rSSus0eqmJrcVIXeifqRg0MtSi-BD_Y",
    title: "Lofotrådet bidrag årsberetning 2014",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2014,
  },
  {
    driveId: "1z2kdKaA98rfTXOXRh6CqNrJBvMWr6tEw",
    title: "Lofotrådet bidrag årsberetning 2015",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2015,
  },
  {
    driveId: "1SuPyy1em7r3SS8TjhQGNgEjctKt5BL37",
    title: "Lofotrådet bidrag årsberetning 2017",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2017,
  },
  {
    driveId: "1Hszk3o6sH7z3Pz0Vex1lA1t3e4wvpm6d",
    title: "Lofotrådet bidrag årsberetning 2018",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2018,
  },
  {
    driveId: "1gmI9gtacNWHEo78EHeNJjoqPPNaQmv-5",
    title: "Lofotrådet bidrag årsberetning 2019",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2019,
  },
  {
    driveId: "1Kzs6Ky8NLREd57l4FtPh5iBbSPaiAwXb",
    title: "Lofotrådet bidrag årsberetning 2020",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2020,
  },
  {
    driveId: "1lEQM1xk-bFwU5HUzGCZIhBUJwPVTIMGN",
    title: "Lofotrådet bidrag årsberetning 2021",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2021,
  },
  {
    driveId: "1lL9hHhaztT2rRAodFyqaDIGgTIb5uft6",
    title: "Lofotrådet bidrag årsberetning 2022",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2022,
  },
  {
    driveId: "1fOnjNPX7HL6vKAP4Foz6BrEw_llO0h-H",
    title: "Lofotrådet bidrag årsberetning 2023",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2023,
  },
  {
    driveId: "1xpac6AzFwGI8CHIcQDhb-owGKhe3vz6H",
    title: "Lofotrådet bidrag årsberetning 2024",
    category: "rapport",
    municipality: "Lofoten",
    publisher: "Lofotrådet",
    year: 2024,
  },
  // ── plan / værøy-kommune ─────────────────────────────────────────
  {
    driveId: "1PfIY2XWkc4YQC1EhSUHWvPW4Syxhm4W4",
    title: "Kommuneplanens samfunnsplan 2022-2034 – Værøy",
    category: "plan",
    municipality: "Værøy",
    publisher: "Værøy kommune",
    year: 2022,
  },
  {
    driveId: "1DH-gwKkq4hjyIg1-P3YjpPZlO7n00z1z",
    title: "Øykommune prosjektet – Værøy",
    category: "plan",
    municipality: "Værøy",
    publisher: "Værøy kommune",
  },
  {
    driveId: "1d935a_KWpzCmSWAxsY5So9kHOn74f5SU",
    title: "Kulturminneplan for Værøy",
    category: "plan",
    municipality: "Værøy",
    publisher: "Værøy kommune",
  },
  {
    driveId: "182TRe5-iclsS0wx01ZPpMmrk71FFkAy1",
    title: "Vedtatt ferdselsåreplan Værøy 07.12.23",
    category: "plan",
    municipality: "Værøy",
    publisher: "Værøy kommune",
    year: 2023,
  },
  {
    driveId: "1V_eaUkRWs1itugLVtClPXUmM7iDbfTu0",
    title: "Planprogram KPA Værøy",
    category: "plan",
    municipality: "Værøy",
    publisher: "Værøy kommune",
  },
  // ── plan / moskenes-kommune ──────────────────────────────────────
  {
    driveId: "1Yie8-BSC9X7leJWhKQTJFKtzAY8CJbvr",
    title: "Kommuneplanens samfunnsdel Moskenes kommune",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
  },
  {
    driveId: "11yNF11sAowugG0B3Bv5afRp49kjjytKC",
    title: "Handlingsplan for bærekraftig reiseliv – Lofoten",
    category: "plan",
    municipality: "Lofoten",
    publisher: "Moskenes kommune",
  },
  {
    driveId: "1-6sWNiJ-cJq5oeFRDFIOu1hfFw6KzfuL",
    title: "Kommunedelplan naturmangfold – Moskenes",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
  },
  {
    driveId: "17vo-3nIHNAGVxz22rZrfA_Qla-HTPoAu",
    title: "Lofotodden nasjonalpark – Moskenes",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
  },
  {
    driveId: "1RCqPHDkK3QFXui1sNulCdwJbUdS0FAuy",
    title: "Rapport forprosjektet – kommunestyret 31.1.23 – Moskenes",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
    year: 2023,
  },
  {
    driveId: "1LgRu2iSNJtoMVtkEBogtbFXWyDifoGPy",
    title: "Temaplan fysisk aktivitet, idrett og friluftsliv – Moskenes",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
  },
  {
    driveId: "1Xd5rDyY32npf-7AETr7CjXmOo5VfpAza",
    title: "Strategi for Moskenes",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
  },
  {
    driveId: "1HZ-AqA4M3d90DzfOcj95QEbcpqQrBKAC",
    title: "Alkoholpolitisk handlingsplan 2024–2028 – Moskenes",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
    year: 2024,
  },
  {
    driveId: "116dPvx3ALrBmk25rfV5TSSKwMMg53GbR",
    title: "Planprogram kommuneplanens arealdel 2025-2037 og naturmangfold – Moskenes",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
    year: 2025,
  },
  {
    driveId: "1pvMABUTurufgqADE4823nN70TpiBXSYv",
    title: "Reguleringsplan 1401815 – Moskenes",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
  },
  {
    driveId: "1IPTMATyrkQoo6H5eaDJlnGWq0Tspw_2W",
    title: "Reguleringsplan 1394551 – Moskenes",
    category: "plan",
    municipality: "Moskenes",
    publisher: "Moskenes kommune",
  },
  // ── plan / flakstad-kommune ──────────────────────────────────────
  {
    driveId: "1znpYpJ-76e4vGvRK-5ZL-9yK1Mwavbdy",
    title: "Kommunal planstrategi 2024-2027 – Flakstad",
    category: "plan",
    municipality: "Flakstad",
    publisher: "Flakstad kommune",
    year: 2024,
  },
  {
    driveId: "1ibzvJrtn7iVcerXCOMDEl9qSeQbwRClh",
    title: "Kommuneplanens samfunnsdel – vedtatt versjon – Flakstad",
    category: "plan",
    municipality: "Flakstad",
    publisher: "Flakstad kommune",
  },
  {
    driveId: "1CJLAmjumeeS9I0A5rjerrp3yWBDlkQzm",
    title: "Trafikksikkerhetsplan – Flakstad",
    category: "plan",
    municipality: "Flakstad",
    publisher: "Flakstad kommune",
  },
  {
    driveId: "1So6n-2XK16K6qpcjvxUib8IO5wPaV6Ma",
    title: "Utviklingsplan Fredvang–Kvalvika – Flakstad",
    category: "plan",
    municipality: "Flakstad",
    publisher: "Flakstad kommune",
    year: 2020,
  },
  {
    driveId: "1jXzlknPkC7nhS0DTHrdk5AyBcgvusnc0",
    title: "Naturmangfoldplan – Flakstad",
    category: "plan",
    municipality: "Flakstad",
    publisher: "Flakstad kommune",
  },
  // ── plan / vestvågøy-kommune ─────────────────────────────────────
  {
    driveId: "1gDQGhtp1OqQ25rWdgCPOLYRrRWseek5l",
    title: "Vestvågøy kunnskapsgrunnlag 2024-2028",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
    year: 2024,
  },
  {
    driveId: "1l_APgrNeK-jqAOLZTmbqo34dnsm3GQVe",
    title: "Vestvågøy planbeskrivelse planstrategi 03.12.24",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
    year: 2024,
  },
  {
    driveId: "1NF2akaGqL1PUPux-UlHU4IgtC4Si-5Vg",
    title: "Kommuneplanens samfunnsdel – Vestvågøy",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
  },
  {
    driveId: "19XkX6brjeN-kolFXDNQ6k28akmLNgCbZ",
    title: "Jordvernstrategi – Vestvågøy",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
  },
  {
    driveId: "1Okwcx-mU4LmfcXcyte_puGJSxQiLlpHP",
    title: "Kommunedelplan oppvekst – vedtatt 23.06.20 – Vestvågøy",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
    year: 2020,
  },
  {
    driveId: "1mtcljSeUllNmJ8CNElDyQgutpvg1_M3U",
    title: "Kommunedelplan kultur 2020-2030 – Vestvågøy",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
    year: 2020,
  },
  {
    driveId: "1VrkLWmaZAWRqHL9B7MffyXkwE_XpVAzA",
    title: "Kommunedelplan helse og omsorg 2020-2030 – Vestvågøy",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
    year: 2020,
  },
  {
    driveId: "1h4pk-DF78EZjCBFLazKLW_QmJgqmO9Gq",
    title: "Kommunedelplan næring 2020-2030 – Vestvågøy",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
    year: 2020,
  },
  {
    driveId: "1bJQXqc0yz9CGZFMZEvKHCTkBAdodMEeW",
    title: "Planbeskrivelse 150523 – Vestvågøy",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
    year: 2023,
  },
  {
    driveId: "1uSduFnT0OhJM6Pjk9MGhbPuZ-3mGqLLj",
    title: "Temaplan psykisk helse 2025-2029 – Vestvågøy",
    category: "plan",
    municipality: "Vestvågøy",
    publisher: "Vestvågøy kommune",
    year: 2025,
  },
  // ── plan / vågan-kommune ─────────────────────────────────────────
  {
    driveId: "1cxK6TAKKxIb6B3sP6H0Jjmlhw-R5q63r",
    title: "Planstrategi for Vågan kommune 2024-2027",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
    year: 2024,
  },
  {
    driveId: "1e8UiqCQf4J5rDaXXCPyQLwM2sxp32f1r",
    title: "Satsning for befolkningsvekst i Vågan kommune – arbeidsdokument til samfunnsdel 2020-2032",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
    year: 2020,
  },
  {
    driveId: "12_gC6fVWgsXWn6A-a9jGxVjMDRQP-J6l",
    title: "ROS-analyse for arealplanen 2017-2029 – Vågan",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
    year: 2017,
  },
  {
    driveId: "1puRwewhudWQTlBJwlmm92H1QPCud_FPt",
    title: "Arealplan for Vågan med kystsonen 2017-2029",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
    year: 2017,
  },
  {
    driveId: "1hXvDOpSiMIr2YQFE6QT1AybrbguwQdCG",
    title: "Kommuneplanens arealdel – bestemmelser og retningslinjer – Vågan",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
  },
  {
    driveId: "16xYfJ2iUYu6xmYgOBhZlj7BWvJACxZNK",
    title: "Kommuneplanens arealdel med kystsonen 2017-2029 – Vågan",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
    year: 2017,
  },
  {
    driveId: "1C-TsS6dYqffUgspj4TPv36o_pkkgOQoP",
    title: "Konsekvensutredning steinbrudd i Vågan – arealdelen 2017-2029",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
    year: 2017,
  },
  {
    driveId: "10N4ze3ylvDdYA1pNdMHcDz-jcBVCaO1u",
    title: "Konsekvensutredning spredt bebyggelse – arealplanen Vågan",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
  },
  {
    driveId: "1R9HH9LefGeIJh7XuVH4dWWNoTpDsW_bN",
    title: "Konsekvensutredning byggeområder – sluttbehandling arealplan Vågan",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
  },
  {
    driveId: "1PEwtkA5XYn4xq7TNy72OvQaAUx-6jVNN",
    title: "Planprogram arealdel Vågan kommune – offentlig ettersyn",
    category: "plan",
    municipality: "Vågan",
    publisher: "Vågan kommune",
  },
  // ── plan / lofoten-de-grønne-øyene ──────────────────────────────
  {
    driveId: "1OJCRA9_i_adCSQJisKB1O-hE9xEJAZRT",
    title: "Veikart Lofoten – De Grønne Øyene feb 2022",
    category: "plan",
    municipality: "Lofoten",
    publisher: "Lofoten – De Grønne Øyene",
    year: 2022,
  },
  // ── plan / nordland-fylkeskommune — regional plan for livskraftige lokalsamfunn (høring) ──
  {
    driveId: "1y3I7sZVfTGggUltc62YqdgvQiaV2Xz1_",
    title: "Høring og offentlig ettersyn – Regional plan for livskraftige lokalsamfunn – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
  {
    driveId: "1B_khT0aAI2Vnaqhza3PVz2ftP8uK5xIO",
    title: "Høringsbrev – Regional plan for livskraftige lokalsamfunn – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
  {
    driveId: "1QudHaephthrElMHHl2nz-usVIdnkZ3c8",
    title: "Høringsnotat – Planutkast regional plan for livskraftige lokalsamfunn – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
  {
    driveId: "17784HZO6m0Wg2FUpEonrt2TrOWAIZwg9",
    title: "Vedlegg 1 – Lenker kunnskapsgrunnlag – Regional plan for livskraftige lokalsamfunn – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
  {
    driveId: "1Y_dZk3sFwAnj9rVi9a0m26nBNwDDHHpx",
    title: "Vedlegg 2 – Kunnskapsgrunnlag befolkning, helse og levekår – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
  {
    driveId: "1zVGZXvvWBnYcAuopmQppxXR76AYqRNrH",
    title: "Vedlegg 4 – Kunnskapsgrunnlag arealbruk og planlegging – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
  {
    driveId: "1-j7hf5qX2tY5GEW6V1O1BjasfIMHFgb8",
    title: "Vedlegg 5 – Planbeskrivelse regional plan for livskraftige lokalsamfunn – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
  {
    driveId: "1g69kDzz_JBi1YKJpXm5cnsv_Yq5sccGj",
    title: "Vedlegg 6 – Bærekraftvurdering av regionale planer for arealpolitikk og livskraftige lokalsamfunn – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
  {
    driveId: "1IADi4-HbuHtkeWAa2M0N6z7z3ErWXMgJ",
    title: "Vedlegg 7 – Bærekraftvurdering: samlet fremstilling – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
  {
    driveId: "1jKU81wlqua4asPeuSsbSN1R4bZGrAzAH",
    title: "Vedlegg 8 – Bærekraftvurdering: forslag til endring av delmål, strategier og tiltak – Nordland",
    category: "plan",
    municipality: "Nordland",
    publisher: "Nordland fylkeskommune",
  },
];

// ----------------------------------------------------------------
// OAuth2 helpers
// ----------------------------------------------------------------
function getOAuth2Client(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("\n❌  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
    console.error("   See README for how to create Google Cloud OAuth2 Desktop credentials.\n");
    process.exit(1);
  }
  return new google.auth.OAuth2(clientId, clientSecret, "http://localhost:3457");
}

async function loadOrRefreshToken(oauth2: OAuth2Client): Promise<void> {
  if (fs.existsSync(CREDENTIALS_PATH)) {
    const stored = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    oauth2.setCredentials(stored);
    // Force a refresh if expiry is within 5 minutes
    if (stored.expiry_date && stored.expiry_date - Date.now() < 300_000) {
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      saveToken(credentials);
    }
    return;
  }
  console.error(`\n❌  No stored credentials found at ${CREDENTIALS_PATH}`);
  console.error("   Run: npm run sync:drive:auth\n");
  process.exit(1);
}

function saveToken(credentials: object): void {
  const dir = path.dirname(CREDENTIALS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
}

// ----------------------------------------------------------------
// One-time auth flow (npm run sync:drive:auth)
// ----------------------------------------------------------------
export async function runAuthFlow(): Promise<void> {
  const oauth2 = getOAuth2Client();
  const authUrl = oauth2.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });

  console.log("\n🔐  Google Drive auth — open this URL in your browser:\n");
  console.log("   " + authUrl + "\n");

  // Receive the code on a local redirect
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost:3456");
      const code = url.searchParams.get("code");
      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>✅ Auth complete — you can close this tab</h2>");
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end("No code");
        reject(new Error("No code in redirect"));
      }
    });
    server.listen(3457, () => console.log("   Waiting for browser redirect on http://localhost:3457 …"));
  });

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  saveToken(tokens);
  console.log(`\n✅  Credentials saved to ${CREDENTIALS_PATH}`);
}

// ----------------------------------------------------------------
// Walk the Drive folder tree
// ----------------------------------------------------------------
const FOLDER_MIME = "application/vnd.google-apps.folder";
const GDOC_MIME = "application/vnd.google-apps.document";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  folders: string[]; // folder names below ROOT_FOLDER_ID, outermost first
}

async function listFolder(drive: drive_v3.Drive, folderId: string, folders: string[] = []): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.mimeType === FOLDER_MIME) {
        out.push(...(await listFolder(drive, f.id!, [...folders, f.name!])));
      } else {
        out.push({ id: f.id!, name: f.name!, mimeType: f.mimeType!, folders });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

function fileTypeOf(f: DriveFile): "pdf" | "docx" | null {
  if (f.mimeType === "application/pdf") return "pdf";
  if (f.mimeType === DOCX_MIME || f.mimeType === GDOC_MIME) return "docx";
  return null;
}

// "Vedlegg_4_kunnskapsgrunnlag_2022886_1_A_2727838.pdf" → "Vedlegg 4 kunnskapsgrunnlag"
function titleFromFilename(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/(_\d{5,}_\d+_[A-Z]_\d{5,})$/, "") // archive reference suffix
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metaFromFolders(folders: string[]): Pick<FileManifest, "category" | "municipality" | "publisher"> {
  const [first, second] = folders.map((s) => s.trim());
  const category = CATEGORIES.find((c) => c === first?.toLowerCase()) ?? "annet";
  if (!second) return { category };
  const known = FOLDER_META[second.toLowerCase()];
  if (known) return { category, ...known };
  const name = second.replace(/-kommune$/i, "").replace(/-/g, " ");
  return { category, municipality: name.charAt(0).toUpperCase() + name.slice(1) };
}

// ----------------------------------------------------------------
// Download a Drive file to a temp path (Google Docs are exported as .docx)
// ----------------------------------------------------------------
async function downloadFile(drive: drive_v3.Drive, file: DriveFile, destPath: string): Promise<void> {
  const dest = fs.createWriteStream(destPath);
  const response = file.mimeType === GDOC_MIME
    ? await drive.files.export({ fileId: file.id, mimeType: DOCX_MIME }, { responseType: "stream" })
    : await drive.files.get({ fileId: file.id, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
  await new Promise<void>((resolve, reject) => {
    (response.data as NodeJS.ReadableStream)
      .pipe(dest)
      .on("finish", resolve)
      .on("error", reject);
  });
}

// ----------------------------------------------------------------
// Main sync
// ----------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  // Auth mode
  if (args.includes("--auth")) {
    await runAuthFlow();
    return;
  }

  const oauth2 = getOAuth2Client();
  await loadOrRefreshToken(oauth2);
  google.options({ auth: oauth2 });
  const drive = google.drive({ version: "v3", auth: oauth2 });

  // Collect files: everything in the folder tree + overrides living elsewhere
  console.log(`\n📂  Listing Drive folder ${ROOT_FOLDER_ID} …`);
  const files = await listFolder(drive, ROOT_FOLDER_ID);
  const overrides = new Map(OVERRIDES.map((o) => [o.driveId, o]));
  const inTree = new Set(files.map((f) => f.id));
  for (const o of OVERRIDES) {
    if (!inTree.has(o.driveId)) files.push({ id: o.driveId, name: o.title, mimeType: "application/pdf", folders: [] });
  }

  // Skip already-ingested files before downloading anything
  const { data: existing, error } = await getSupabaseAdmin().from("documents").select("drive_id");
  if (error) throw new Error(`Could not read documents: ${error.message}`);
  const ingestedIds = new Set((existing ?? []).map((d: { drive_id: string }) => d.drive_id));

  const tmpDir = path.resolve(__dirname, "../.sync-tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  let ingested = 0;
  let skipped = 0;
  let unsupported = 0;
  let failed = 0;

  console.log(`🔄  Syncing ${files.length} Drive files → Supabase RAG`);
  console.log(`    force=${force} dryRun=${dryRun}\n`);

  for (const [i, file] of files.entries()) {
    const fileType = fileTypeOf(file);
    const label = `[${i + 1}/${files.length}] ${[...file.folders, file.name].join(" / ")}`;
    if (!fileType) {
      console.log(`${label}\n   ⚠️  Unsupported type ${file.mimeType} — skipped`);
      unsupported++;
      continue;
    }
    if (!force && ingestedIds.has(file.id)) {
      skipped++;
      continue;
    }

    const o = overrides.get(file.id);
    const fromFolders = metaFromFolders(file.folders);
    if (dryRun) {
      console.log(`${label}\n   🆕 Would ingest as "${o?.title ?? titleFromFilename(file.name)}" ` +
        `(${o?.category ?? fromFolders.category}, ${o?.municipality ?? fromFolders.municipality ?? "–"})`);
      ingested++;
      continue;
    }
    const tmpPath = path.join(tmpDir, `${file.id}.${fileType}`);
    try {
      console.log(`\n${label}`);
      await downloadFile(drive, file, tmpPath);
      const result = await ingestDocument(
        {
          driveId: file.id,
          title: o?.title ?? titleFromFilename(file.name),
          sourceUrl: `https://drive.google.com/file/d/${file.id}/view`,
          category: o?.category ?? fromFolders.category ?? "annet",
          year: o?.year,
          publisher: o?.publisher ?? fromFolders.publisher,
          municipality: o?.municipality ?? fromFolders.municipality,
          fileType,
        },
        fs.readFileSync(tmpPath),
        force
      );
      if (result.chunksCreated === 0) {
        skipped++;
      } else {
        ingested++;
      }
    } catch (err: any) {
      console.error(`   ❌  Failed: ${err.message}`);
      failed++;
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  // Cleanup tmp dir if empty
  try { fs.rmdirSync(tmpDir); } catch {}

  console.log(`\n✅  Sync complete`);
  console.log(`   Ingested    : ${ingested}`);
  console.log(`   Skipped     : ${skipped} (already indexed)`);
  console.log(`   Unsupported : ${unsupported}`);
  console.log(`   Failed      : ${failed}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
