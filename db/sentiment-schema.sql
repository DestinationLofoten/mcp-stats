-- ============================================================
-- NorData — Sentiment Analysis Schema
-- Run this in: Supabase Dashboard > SQL Editor
-- ============================================================

-- Enable pgvector (already enabled, but safe to re-run)
create extension if not exists vector;

-- --------------------------------------------------------
-- SENTIMENT_MENTIONS: Raw + analyzed mentions from all sources
-- --------------------------------------------------------
create table if not exists sentiment_mentions (
  id              bigserial primary key,
  source          text not null,           -- 'reddit', 'news', 'tripadvisor', etc.
  source_id       text,                    -- Platform-specific ID (e.g. Reddit post ID)
  url             text unique not null,    -- Deduplicate by URL
  author          text,
  title           text,
  body            text,
  published_at    timestamptz,
  fetched_at      timestamptz default now(),

  -- Analysis fields — NULL until analyze:sentiment has run
  sentiment       text check (sentiment in ('positive', 'neutral', 'negative')),
  sentiment_score numeric(4,3),            -- -1.0 to 1.0
  topics          text[],
  summary         text,                    -- 1-sentence summary
  language        text,                    -- ISO 639-1 code
  analyzed_at     timestamptz,

  -- pgvector embedding (OpenAI text-embedding-3-small, 1536 dims)
  embedding       vector(1536)
);

create index if not exists sentiment_mentions_source_idx
  on sentiment_mentions(source);

create index if not exists sentiment_mentions_published_idx
  on sentiment_mentions(published_at desc);

create index if not exists sentiment_mentions_sentiment_idx
  on sentiment_mentions(sentiment);

-- Partial index for fast "find unanalyzed" queries
create index if not exists sentiment_mentions_unanalyzed_idx
  on sentiment_mentions(fetched_at desc)
  where analyzed_at is null;

-- HNSW index for vector similarity search (same settings as document_chunks)
create index if not exists sentiment_mentions_embedding_idx
  on sentiment_mentions using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- RLS: fetchers use service role, MCP server uses anon
alter table sentiment_mentions enable row level security;

create policy "anon can read sentiment_mentions"
  on sentiment_mentions for select
  to anon using (true);

-- --------------------------------------------------------
-- MATERIALIZED VIEWS (refreshed after each analysis run)
-- --------------------------------------------------------

-- Weekly summary per source
create materialized view if not exists sentiment_weekly_summary as
  select
    date_trunc('week', published_at)::date                          as week_start,
    source,
    count(*)                                                        as mention_count,
    round(avg(sentiment_score)::numeric, 3)                         as avg_score,
    count(*) filter (where sentiment = 'positive')                  as positive_count,
    count(*) filter (where sentiment = 'neutral')                   as neutral_count,
    count(*) filter (where sentiment = 'negative')                  as negative_count
  from sentiment_mentions
  where analyzed_at is not null
    and published_at is not null
  group by date_trunc('week', published_at), source
  order by week_start desc, source;

create unique index if not exists sentiment_weekly_summary_idx
  on sentiment_weekly_summary(week_start, source);

-- Top topics over last 30 days
create materialized view if not exists sentiment_topics_30d as
  select
    topic,
    count(*)                                                        as mention_count,
    round(avg(sentiment_score)::numeric, 3)                         as avg_score,
    count(*) filter (where sentiment = 'positive')                  as positive_count,
    count(*) filter (where sentiment = 'neutral')                   as neutral_count,
    count(*) filter (where sentiment = 'negative')                  as negative_count
  from sentiment_mentions,
    unnest(topics) as topic
  where analyzed_at is not null
    and published_at >= now() - interval '30 days'
  group by topic
  order by mention_count desc;

-- --------------------------------------------------------
-- RPC: Refresh materialized views (called after analysis runs)
-- --------------------------------------------------------
create or replace function refresh_sentiment_views()
returns void
language sql
as $$
  refresh materialized view concurrently sentiment_weekly_summary;
  refresh materialized view concurrently sentiment_topics_30d;
$$;

-- --------------------------------------------------------
-- RPC: Semantic search over analyzed mentions
-- --------------------------------------------------------
create or replace function match_sentiment_mentions(
  query_embedding   vector(1536),
  match_threshold   float    default 0.5,
  match_count       int      default 10,
  filter_source     text     default null,
  filter_sentiment  text     default null,
  filter_days       int      default null
)
returns table (
  id              bigint,
  source          text,
  url             text,
  author          text,
  title           text,
  summary         text,
  sentiment       text,
  sentiment_score numeric,
  topics          text[],
  published_at    timestamptz,
  similarity      float
)
language sql stable
as $$
  select
    m.id,
    m.source,
    m.url,
    m.author,
    m.title,
    m.summary,
    m.sentiment,
    m.sentiment_score,
    m.topics,
    m.published_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from sentiment_mentions m
  where m.embedding is not null
    and m.analyzed_at is not null
    and 1 - (m.embedding <=> query_embedding) > match_threshold
    and (filter_source    is null or m.source    = filter_source)
    and (filter_sentiment is null or m.sentiment = filter_sentiment)
    and (filter_days      is null or m.published_at >= now() - (filter_days || ' days')::interval)
  order by m.embedding <=> query_embedding
  limit match_count;
$$;
