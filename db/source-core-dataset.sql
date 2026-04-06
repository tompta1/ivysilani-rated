CREATE TABLE IF NOT EXISTS source_core_dataset_versions (
  id bigserial PRIMARY KEY,
  dataset_key text NOT NULL UNIQUE,
  generated_at timestamptz NOT NULL,
  item_count integer NOT NULL,
  poster_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dataset_json jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS source_core_dataset_versions_generated_at_idx
  ON source_core_dataset_versions (generated_at DESC);
