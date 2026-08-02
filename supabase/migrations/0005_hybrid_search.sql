-- One-call hybrid retrieval: semantic (vector/HNSW) + full-text (ts_rank) +
-- trigram word-similarity, fused with Reciprocal Rank Fusion. Single round-trip,
-- fully indexed. Applied to project rtpjoqplyiedmravytbl on 2026-05-26.
create or replace function public.hybrid_search(
  query_embedding vector(1536),
  query_text text,
  p_project_id uuid,
  match_count int default 40,
  rrf_k int default 50
)
returns table (id uuid, content text, metadata jsonb, similarity float, score float)
language sql stable
as $$
  with tsq as (
    select websearch_to_tsquery('simple', coalesce(nullif(trim(query_text), ''), 'zzzznomatchzzzz')) as q
  ),
  semantic as (
    select e.id,
           1 - (e.embedding <=> query_embedding) as sim,
           row_number() over (order by e.embedding <=> query_embedding) as rank
    from public.embeddings e
    where e.project_id = p_project_id
    order by e.embedding <=> query_embedding
    limit match_count * 2
  ),
  fulltext as (
    select e.id,
           row_number() over (order by ts_rank_cd(e.fts, (select q from tsq)) desc) as rank
    from public.embeddings e
    where e.project_id = p_project_id
      and e.fts @@ (select q from tsq)
    limit match_count * 2
  ),
  trigram as (
    select e.id,
           row_number() over (order by word_similarity(query_text, e.content) desc) as rank
    from public.embeddings e
    where e.project_id = p_project_id
      and query_text <% e.content
    limit match_count * 2
  ),
  ids as (
    select id from semantic
    union select id from fulltext
    union select id from trigram
  ),
  fused as (
    select i.id,
           coalesce(1.0/(rrf_k + s.rank), 0)
         + coalesce(1.0/(rrf_k + f.rank), 0)
         + coalesce(1.0/(rrf_k + t.rank), 0) as score,
           s.sim
    from ids i
    left join semantic s on s.id = i.id
    left join fulltext f on f.id = i.id
    left join trigram t on t.id = i.id
  )
  select e.id, e.content, e.metadata,
         coalesce(fused.sim, 0)::float as similarity,
         fused.score::float as score
  from fused
  join public.embeddings e on e.id = fused.id
  order by fused.score desc
  limit match_count;
$$;

grant execute on function public.hybrid_search(vector, text, uuid, int, int) to service_role, authenticated, anon;
