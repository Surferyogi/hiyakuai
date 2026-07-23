-- HiyakuAI - suitability assessment (2026-07-17)
-- Additive only: stores the AI suitability assessment shown in the app
-- (verdict, score, summary, strengths, gaps, emphasis, assessed_at, model).
-- Already applied to project qdikrhoxkkangkoycagj via migration
-- "add_suitability_to_hiyaku_applications" on 2026-07-16 (UTC).
ALTER TABLE public.hiyaku_applications ADD COLUMN IF NOT EXISTS suitability jsonb;
