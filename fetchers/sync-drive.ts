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
 *   npm run sync:drive                (skips already-ingested files automatically)
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

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const CREDENTIALS_PATH = path.resolve(__dirname, "../.credentials/google.json");
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

// ----------------------------------------------------------------
// File manifest — all Drive files to sync into RAG
// ----------------------------------------------------------------
interface FileManifest {
  driveId: string;
  title: string;
  category: "strategi" | "rapport" | "plan" | "utredning" | "statistikk";
  municipality?: string;
  publisher?: string;
  year?: number;
}

const FILES: FileManifest[] = [
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
// Download a Drive file to a temp path
// ----------------------------------------------------------------
async function downloadFile(drive: drive_v3.Drive, fileId: string, destPath: string): Promise<void> {
  const dest = fs.createWriteStream(destPath);
  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );
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

  // Auth mode
  if (args.includes("--auth")) {
    await runAuthFlow();
    return;
  }

  const oauth2 = getOAuth2Client();
  await loadOrRefreshToken(oauth2);
  google.options({ auth: oauth2 });
  const drive = google.drive({ version: "v3", auth: oauth2 });

  const tmpDir = path.resolve(__dirname, "../.sync-tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`\n🔄  Syncing ${FILES.length} Drive files → Supabase RAG`);
  console.log(`    force=${force}\n`);

  for (const file of FILES) {
    const tmpPath = path.join(tmpDir, `${file.driveId}.pdf`);
    try {
      console.log(`\n[${ingested + skipped + failed + 1}/${FILES.length}] ${file.title}`);
      await downloadFile(drive, file.driveId, tmpPath);
      const result = await ingestDocument(
        {
          driveId: file.driveId,
          title: file.title,
          sourceUrl: `https://drive.google.com/file/d/${file.driveId}/view`,
          category: file.category,
          year: file.year,
          publisher: file.publisher,
          municipality: file.municipality,
          fileType: "pdf",
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
  console.log(`   Ingested : ${ingested}`);
  console.log(`   Skipped  : ${skipped} (already indexed)`);
  console.log(`   Failed   : ${failed}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
