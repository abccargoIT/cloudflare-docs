-- Lets a customer be matched to their shipment when they quote the reference
-- back to us the way we printed it.
--
-- Intent recognition normalises every reference it finds — ABC-UAE-088210
-- becomes ABCUAE088210 — because that is the only way one key can match the
-- several ways a customer types the same number. The lookup, however, compared
-- that normalised key against the stored reference, which still carries its
-- dashes. The two never matched, so a customer quoting the exact reference on
-- their own paperwork was not connected to their own shipment.
--
-- A virtual generated column holds the normalised form, so it cannot drift
-- from `ref` and nothing has to remember to populate it on insert.
ALTER TABLE bookings ADD COLUMN ref_key TEXT
	GENERATED ALWAYS AS (UPPER(REPLACE(REPLACE(ref, '-', ''), ' ', ''))) VIRTUAL;

CREATE INDEX IF NOT EXISTS idx_bookings_ref_key ON bookings (ref_key);
