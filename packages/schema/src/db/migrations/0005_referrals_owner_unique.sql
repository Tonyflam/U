-- Add the unique constraint that ON CONFLICT (owner_user_id) in
-- getOrMintReferralCode relies on. Existing duplicates (if any) are
-- collapsed by keeping the earliest-created row.
DELETE FROM "referrals" a
USING "referrals" b
WHERE a.created_at > b.created_at
  AND a.owner_user_id = b.owner_user_id;

ALTER TABLE "referrals"
  ADD CONSTRAINT "referrals_owner_user_id_unique" UNIQUE ("owner_user_id");
