-- Single-use links for setting and resetting a password.
--
-- Before this, an administrator typed a new person's first password and told
-- them what it was. That is the one part of the system where a credential
-- travelled outside it — over WhatsApp, usually — and it defeats the audit
-- trail everything else works to keep: the log can say who created the account,
-- but not that only that person has ever known the password.
--
-- The replacement is a token the administrator copies and sends. The person
-- opens it, chooses their own password, and nobody else ever sees it. There is
-- deliberately no email server involved: the club reaches its staff on their
-- phones, and an SMTP dependency that has to work before anyone can sign in is
-- a worse failure mode than a link that is pasted by hand.
--
-- Not destructive: one new table and one relaxed CHECK. §B19.5.

CREATE TABLE IF NOT EXISTS password_setup_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only the hash is stored, exactly as for refresh tokens and collector keys.
  -- The link is shown once, at creation, and cannot be recovered afterwards.
  token_hash  TEXT        NOT NULL UNIQUE,
  purpose     TEXT        NOT NULL CHECK (purpose IN ('setup', 'reset')),
  created_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live link per person. Minting a second silently invalidates the first,
-- which is what "make a new link" has to mean: an administrator who reissues a
-- link because the old one went astray must not leave the old one working.
CREATE UNIQUE INDEX IF NOT EXISTS password_setup_tokens_live_uq
  ON password_setup_tokens (user_id) WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS password_setup_tokens_expiry_idx
  ON password_setup_tokens (expires_at);

COMMENT ON TABLE password_setup_tokens IS
  'Single-use links for choosing a password. Hashed; the raw value is shown once.';

-- An account may now exist with no password at all: created, link sent, not yet
-- redeemed. The previous constraint required a hash the moment the row existed,
-- which forced an administrator to invent one.
--
-- Nothing is weakened by allowing NULL. `findCredentials` returns a null hash,
-- the local auth provider refuses it before argon2 is reached, and every
-- sign-in path treats "no password set" exactly as it treats a wrong one.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_local_needs_hash;

COMMENT ON COLUMN users.password_hash IS
  'NULL means no password has been chosen yet — an outstanding setup link, or an external provider.';
