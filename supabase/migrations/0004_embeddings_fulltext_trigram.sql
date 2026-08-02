-- Lexical search infrastructure for the embeddings table.
-- Applied to project rtpjoqplyiedmravytbl on 2026-05-26.
-- Replaces the prior app-level `.ilike` fallback with indexed full-text + trigram.

create extension if not exists pg_trgm;

-- Full-text vector over content ('simple' config: no stemming — suits code/identifiers).
alter table public.embeddings
  add column if not exists fts tsvector
  generated always as (to_tsvector('simple', content)) stored;

create index if not exists embeddings_fts_idx
  on public.embeddings using gin (fts);

-- Trigram index: fast ILIKE + word_similarity (camelCase<->snake_case, partial identifiers).
create index if not exists embeddings_content_trgm_idx
  on public.embeddings using gin (content gin_trgm_ops);
