import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

dotenv.config();

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment variables.\n" +
    "Copy .env.example to .env and fill in your values."
  );
}

// Read-only client — used by MCP server and report agent
export const supabase = createClient(url, anonKey);

// Write client — used by fetchers only (bypasses RLS).
// Throws at call time rather than module load, so the MCP server
// can import this file without needing SUPABASE_SERVICE_ROLE_KEY.
export function getSupabaseAdmin() {
  if (!serviceKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY — required for fetchers.");
  }
  return createClient(url!, serviceKey);
}
