require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  // Count rows
  const { count } = await supabase
    .from("ssb_observations")
    .select("*", { count: "exact", head: true });

  console.log(`\nssb_observations: ${count?.toLocaleString()} rows`);

  // Sample a few rows to estimate average size
  const { data, error } = await supabase
    .from("ssb_observations")
    .select("*")
    .limit(5);

  if (data) {
    const avgRowSizeBytes = JSON.stringify(data[0]).length;
    const totalEstimatedMB = (count * avgRowSizeBytes) / (1024 * 1024);
    
    console.log(`Average row size (JSON): ~${avgRowSizeBytes} bytes`);
    console.log(`Estimated table size: ~${totalEstimatedMB.toFixed(1)} MB`);
    console.log(`\nIf fetching 10 years (120 months) instead of 3 years (36 months):`);
    console.log(`  Multiplier: 120/36 = 3.33x`);
    console.log(`  Estimated new size: ~${(totalEstimatedMB * 3.33).toFixed(1)} MB`);
  }
}

check().catch(console.error);
