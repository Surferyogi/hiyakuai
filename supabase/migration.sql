-- ============================================================
-- HiyakuAI schema  v2026:07:05-15:53
-- Run once in Supabase SQL Editor of the hiyakuai project.
-- Creates: profile, links, certificates, applications + RLS +
-- private storage bucket for certificate files.
-- ============================================================

-- 1) Reference profile (single row per user)
create table if not exists hiyaku_profile (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cv_markdown text default '',
  linkedin_headline text default '',
  linkedin_about text default '',
  extra_notes text default '',
  updated_at timestamptz default now(),
  unique (user_id)
);

-- 2) Online information sources (LinkedIn, publications, etc.)
create table if not exists hiyaku_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  url text not null,
  category text default 'Other',          -- LinkedIn / Publication / Portfolio / Other
  include_in_prompt boolean default true,
  created_at timestamptz default now()
);

-- 3) Certificates & qualifications (files live in storage bucket)
create table if not exists hiyaku_certificates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  note text default '',
  storage_path text not null,             -- path inside bucket hiyaku-certs
  mime_type text default '',
  created_at timestamptz default now()
);

-- 4) Job applications
create table if not exists hiyaku_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company text not null,
  role_title text not null,
  source text default '',                 -- where the job was found
  job_description text default '',
  cv_generated text default '',           -- tailored CV (markdown)
  cover_letter_generated text default '', -- tailored cover letter (markdown)
  fit_notes text default '',              -- AI notes on fit / gaps
  status text not null default 'draft'
    check (status in ('draft','submitted','responded','interview','offer','rejected','closed')),
  date_applied date,
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 5) RLS: owner-only on every table
alter table hiyaku_profile       enable row level security;
alter table hiyaku_links         enable row level security;
alter table hiyaku_certificates  enable row level security;
alter table hiyaku_applications  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['hiyaku_profile','hiyaku_links','hiyaku_certificates','hiyaku_applications'] loop
    execute format('drop policy if exists "%s_owner" on %s', t, t);
    execute format(
      'create policy "%s_owner" on %s for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t, t);
  end loop;
end $$;

-- 6) Private storage bucket for certificates
insert into storage.buckets (id, name, public)
values ('hiyaku-certs','hiyaku-certs', false)
on conflict (id) do nothing;

drop policy if exists "hiyaku_certs_owner_all" on storage.objects;
create policy "hiyaku_certs_owner_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'hiyaku-certs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'hiyaku-certs' and (storage.foldername(name))[1] = auth.uid()::text);

-- 7) updated_at trigger for applications & profile
create or replace function hiyaku_touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_hiyaku_apps_touch on hiyaku_applications;
create trigger trg_hiyaku_apps_touch before update on hiyaku_applications
  for each row execute function hiyaku_touch_updated_at();

drop trigger if exists trg_hiyaku_profile_touch on hiyaku_profile;
create trigger trg_hiyaku_profile_touch before update on hiyaku_profile
  for each row execute function hiyaku_touch_updated_at();
