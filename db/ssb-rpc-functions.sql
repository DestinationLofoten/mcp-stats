-- RPC functions used by fetchers/ssb.ts (run with the service role key).
-- search_path is empty for safety, so table names must be schema-qualified.
-- statement_timeout is set per function: PostgREST applies it, overriding the
-- API's default 8s limit, which the 394k-row clear and the view refresh exceed.

CREATE OR REPLACE FUNCTION public.clear_ssb_dataset(p_dataset_id bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5min'
AS $function$
BEGIN
  DELETE FROM public.ssb_observations WHERE dataset_id = p_dataset_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_ssb_overnights_view()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5min'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW public.ssb_overnights_by_market;
END;
$function$;
