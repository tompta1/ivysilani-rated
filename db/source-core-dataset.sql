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

CREATE TABLE IF NOT EXISTS ct_catalogue_snapshots (
  id bigserial PRIMARY KEY,
  category_id text NOT NULL,
  snapshot_date date NOT NULL,
  fetched_at timestamptz NOT NULL,
  item_count integer NOT NULL,
  total_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  payload_json jsonb NOT NULL,
  UNIQUE (category_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS ct_catalogue_snapshots_category_fetched_at_idx
  ON ct_catalogue_snapshots (category_id, fetched_at DESC);
