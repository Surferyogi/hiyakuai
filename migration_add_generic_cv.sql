-- HiyakuAI: store the AI-generated generic (master) CV separately from the
-- user's reference CV. Additive and idempotent - existing data untouched.
alter table hiyaku_profile
  add column if not exists generic_cv text default '',
  add column if not exists generic_cv_updated_at timestamptz;
