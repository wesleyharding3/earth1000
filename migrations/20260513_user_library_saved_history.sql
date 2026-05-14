-- ────────────────────────────────────────────────────────────────────────
-- Library: per-user saved items + view history
--
-- Two tables, both keyed by (user_id, kind, ref_id) for upsert semantics.
-- - user_saved_items: idempotent saves — re-saving the same article from
--   another device is a no-op; the row's created_at stays at the FIRST
--   save so the user's library sort order is stable.
-- - user_history: re-viewing the same item UPDATES viewed_at instead of
--   inserting a new row, so the "Recently viewed" list deduplicates
--   correctly. A trigger trims each user to their 500 most recent
--   entries so history can't grow unbounded.
--
-- RLS: each user sees + writes ONLY their own rows. auth.uid() resolves
-- to the Supabase user UUID from the JWT.
-- ────────────────────────────────────────────────────────────────────────

-- ── user_saved_items ────────────────────────────────────────────────────
create table if not exists public.user_saved_items (
  id          bigint primary key generated always as identity,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,    -- 'article' | 'thread' | 'line' | 'view' | 'briefing'
  ref_id      text not null,    -- the underlying entity id (text accepts ints + uuids)
  title       text,
  source      text,
  url         text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint user_saved_items_uniq unique (user_id, kind, ref_id)
);

create index if not exists user_saved_items_user_created_idx
  on public.user_saved_items (user_id, created_at desc);

alter table public.user_saved_items enable row level security;

drop policy if exists "user_saved_items_select_own" on public.user_saved_items;
create policy "user_saved_items_select_own"
  on public.user_saved_items for select
  using (auth.uid() = user_id);

drop policy if exists "user_saved_items_insert_own" on public.user_saved_items;
create policy "user_saved_items_insert_own"
  on public.user_saved_items for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_saved_items_update_own" on public.user_saved_items;
create policy "user_saved_items_update_own"
  on public.user_saved_items for update
  using (auth.uid() = user_id);

drop policy if exists "user_saved_items_delete_own" on public.user_saved_items;
create policy "user_saved_items_delete_own"
  on public.user_saved_items for delete
  using (auth.uid() = user_id);

-- ── user_history ────────────────────────────────────────────────────────
create table if not exists public.user_history (
  id          bigint primary key generated always as identity,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,
  ref_id      text not null,
  title       text,
  source      text,
  metadata    jsonb not null default '{}'::jsonb,
  viewed_at   timestamptz not null default now(),
  constraint user_history_uniq unique (user_id, kind, ref_id)
);

create index if not exists user_history_user_viewed_idx
  on public.user_history (user_id, viewed_at desc);

alter table public.user_history enable row level security;

drop policy if exists "user_history_select_own" on public.user_history;
create policy "user_history_select_own"
  on public.user_history for select
  using (auth.uid() = user_id);

drop policy if exists "user_history_insert_own" on public.user_history;
create policy "user_history_insert_own"
  on public.user_history for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_history_update_own" on public.user_history;
create policy "user_history_update_own"
  on public.user_history for update
  using (auth.uid() = user_id);

drop policy if exists "user_history_delete_own" on public.user_history;
create policy "user_history_delete_own"
  on public.user_history for delete
  using (auth.uid() = user_id);

-- ── Per-user history cap: keep last 500 per user ───────────────────────
-- Fires after every insert; prunes the oldest rows for that user once
-- they exceed the cap. Net effect: each user's history is a rolling
-- window without the client having to manage cap math.
create or replace function public.trim_user_history()
returns trigger language plpgsql as $$
begin
  delete from public.user_history h
   where h.user_id = new.user_id
     and h.id not in (
       select id from public.user_history
        where user_id = new.user_id
        order by viewed_at desc
        limit 500
     );
  return new;
end;
$$;

drop trigger if exists user_history_trim_aft_ins on public.user_history;
create trigger user_history_trim_aft_ins
  after insert on public.user_history
  for each row execute function public.trim_user_history();
