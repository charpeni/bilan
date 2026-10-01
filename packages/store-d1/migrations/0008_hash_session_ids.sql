-- Sessions are now stored under the SHA-256 of their id (see `createSession`).
-- Rows written before hold the raw id, the very value the cookie carries: drop
-- them all. Everyone signs in again once.
DELETE FROM `sessions`;
