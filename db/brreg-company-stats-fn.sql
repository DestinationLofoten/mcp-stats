-- brreg_company_stats: server-side aggregation for the MCP tool of the same name.
-- Applied to Supabase as migration "brreg_company_stats_rpc" (2026-07-10).
--
-- Aggregates in Postgres instead of in the MCP server: the Data API caps a
-- single select at 1,000 rows, and brreg_companies holds several thousand
-- companies per accounting year, so client-side aggregation silently
-- undercounted. total_groups is the number of distinct groups before the
-- limit is applied.
create or replace function brreg_company_stats(
  p_group_by text,
  p_year int default 2024,
  p_limit int default 20
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_result jsonb;
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  if p_group_by not in ('municipality', 'nace_desc', 'org_form_desc') then
    raise exception 'Invalid group_by: %. Must be one of: municipality, nace_desc, org_form_desc', p_group_by;
  end if;

  execute format($q$
    with grouped as (
      select %I as name,
             count(*)::bigint as count,
             (count(*) filter (where has_accounts))::bigint as with_accounts,
             coalesce(sum(employees), 0)::bigint as total_employees,
             coalesce(sum(revenue), 0) as total_revenue,
             coalesce(sum(annual_result), 0) as total_annual_result,
             coalesce(sum(total_assets), 0) as total_assets
      from brreg_companies
      where accounting_year = $1
        and %I is not null
      group by 1
    ),
    top as (
      select * from grouped order by count desc, name asc limit $2
    )
    select jsonb_build_object(
      'total_groups', (select count(*) from grouped),
      'data', coalesce(
        (select jsonb_agg(to_jsonb(top) order by top.count desc, top.name asc) from top),
        '[]'::jsonb
      )
    )
  $q$, p_group_by, p_group_by)
  into v_result
  using p_year, v_limit;

  return v_result;
end;
$$;
