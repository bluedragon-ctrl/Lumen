#!/usr/bin/env node
"use strict";
/**
 * Generate an INVITE_KEY_HASH for the new-player registration gate.
 *
 *   node tools/hash-invite-key.js <invitation-key>
 *   npm run hash-invite-key -- <invitation-key>
 *
 * Prints a ready-to-paste line for your environment / .env:
 *
 *   INVITE_KEY_HASH=<salt>:<hash>
 *
 * The plaintext key is never stored — hand it out-of-band to the people you're
 * inviting. Set the printed value in the server's environment; with it set,
 * creating a prospector requires the invitation key (see server/config.js).
 * Uses the same scrypt hashing as account passwords (server/accounts.js).
 */
const { hashInviteKey } = require("../server/accounts");

const key = process.argv[2];
if (!key) {
  console.error("Usage: node tools/hash-invite-key.js <invitation-key>");
  process.exit(1);
}
if (key.length < 6) {
  console.error("Invitation key must be at least 6 characters.");
  process.exit(1);
}
console.log("INVITE_KEY_HASH=" + hashInviteKey(key));
