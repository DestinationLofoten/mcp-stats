require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  // Get all public tables
  const { data: tables } = await supabase
    .from("information_schema.tables")
    .select("table_name")
    .eq("table_schema", "public");

  if (tables) {
    console.log("Public tables:");
    for (const t of tables) {
      const { count } = await supabase
        .from(t.table_name)
        .select("*", { count: "exact", head: true });
      
      if (count && count > 0) {
        const { data, error } = await supabase
          .from(t.table_name)
          .select("*")
          .limit(1);
        
        if (data && data.length > 0) {
          const rowSize = JSON.stringify(data[0]).length;
          const totalSize = (count * rowSize) / (1024 * 1024);
          console.log(`  ${t.table_name}: ${count.toLocaleString()} rows, ~${totalSize.toFixed(1)} MB`);
        }
      }
    }
  }
}

check().catch(console.error);
