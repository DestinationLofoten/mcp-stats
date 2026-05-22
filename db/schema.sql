-- ============================================================
-- NorData — Supabase Schema
-- Run this in: Supabase Dashboard > SQL Editor
-- ============================================================

-- --------------------------------------------------------
-- BRREG: Companies from Brønnøysundregistrene
-- --------------------------------------------------------
create table if not exists brreg_companies (
  id bigserial primary key,
  organisasjonsnummer text unique not null,   -- 9-digit org number
  navn text not null,                          -- Company name
  organisasjonsform text,                      -- AS, ENK, ANS, etc.
  naeringskode1 text,                          -- Primary NACE code
  naeringskode1_beskrivelse text,              -- NACE description
  antall_ansatte integer,                      -- Number of employees
  forretningsadresse_kommune text,             -- Municipality
  forretningsadresse_fylke text,               -- County
  forretningsadresse_postnummer text,
  forretningsadresse_poststed text,
  stiftelsesdato date,                         -- Founded date
  registreringsdato_enhetsregisteret date,     -- Registered date
  konkurs boolean default false,               -- Bankrupt
  under_avvikling boolean default false,       -- Being wound down
  raw jsonb,                                   -- Full raw API response
  fetched_at timestamptz default now()
);

create index if not exists brreg_companies_organisasjonsnummer_idx
  on brreg_companies(organisasjonsnummer);

create index if not exists brreg_companies_kommune_idx
  on brreg_companies(forretningsadresse_kommune);

create index if not exists brreg_companies_naeringskode_idx
  on brreg_companies(naeringskode1);

create index if not exists brreg_companies_stiftelsesdato_idx
  on brreg_companies(stiftelsesdato);

-- --------------------------------------------------------
-- SSB: Statistical datasets from Statistics Norway
-- --------------------------------------------------------
create table if not exists ssb_datasets (
  id bigserial primary key,
  table_id text not null,                      -- SSB table ID e.g. "07459"
  title text not null,                         -- Human-readable title
  description text,
  unit text,                                   -- Unit of measurement
  source_url text,
  fetched_at timestamptz default now(),
  unique(table_id)
);

create table if not exists ssb_observations (
  id bigserial primary key,
  dataset_id bigint references ssb_datasets(id) on delete cascade,
  region text,                                 -- Region/municipality code or name
  region_name text,
  time_period text,                            -- e.g. "2023", "2023M01"
  time_type text,                              -- "year", "month", "quarter"
  category text,                               -- Additional dimension (age, gender, etc.)
  category_label text,
  value numeric,
  unit text,
  raw jsonb,
  fetched_at timestamptz default now()
);

create index if not exists ssb_observations_dataset_idx
  on ssb_observations(dataset_id);

create index if not exists ssb_observations_region_idx
  on ssb_observations(region);

create index if not exists ssb_observations_time_idx
  on ssb_observations(time_period);

create index if not exists ssb_observations_dataset_region_time_idx
  on ssb_observations(dataset_id, region, time_period);

-- --------------------------------------------------------
-- REPORTS: Generated reports log
-- --------------------------------------------------------
create table if not exists reports (
  id bigserial primary key,
  title text not null,
  prompt text not null,                        -- What was asked
  content text not null,                       -- Generated markdown report
  data_sources text[],                         -- e.g. ['ssb:07459', 'brreg']
  generated_at timestamptz default now()
);

-- --------------------------------------------------------
-- Helper view: Recent SSB data by dataset
-- --------------------------------------------------------
create or replace view ssb_latest as
  select
    d.table_id,
    d.title as dataset_title,
    o.region_name,
    o.time_period,
    o.category_label,
    o.value,
    o.unit
  from ssb_observations o
  join ssb_datasets d on d.id = o.dataset_id
  order by o.time_period desc;
