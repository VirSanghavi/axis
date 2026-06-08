-- Bind browser OAuth sessions to an organization selected during consent.
-- Existing tokens remain valid with org_id NULL and retain legacy fallback behavior.

do $$
begin
  if to_regclass('public.orgs') is not null
     and to_regclass('public.oauth_auth_codes') is not null then
    execute 'alter table oauth_auth_codes
      add column if not exists org_id uuid references orgs(id) on delete cascade';
    execute 'create index if not exists oauth_auth_codes_org_id_idx
      on oauth_auth_codes(org_id)';
  end if;

  if to_regclass('public.orgs') is not null
     and to_regclass('public.oauth_refresh_tokens') is not null then
    execute 'alter table oauth_refresh_tokens
      add column if not exists org_id uuid references orgs(id) on delete cascade';
    execute 'create index if not exists oauth_refresh_tokens_org_id_idx
      on oauth_refresh_tokens(org_id)';
  end if;
end
$$;
