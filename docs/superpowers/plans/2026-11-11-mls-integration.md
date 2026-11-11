# MLS Room Integration Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Check off each milestone only after running its tests.

**Goal:** Integrate the HTTP-compatible OpenMLS adapter into optional encrypted rooms, checked by default.

**Architecture:** Node serializes an opaque protocol log with compare-and-set revisions. Browsers store cryptographic snapshots, an outbox and locally decrypted history atomically in IndexedDB, and drive approval/removal through authenticated MLS commits.

**Tech Stack:** Existing Node/SSE/Vite application, OpenMLS 0.8.3 WASM, IndexedDB.

**Spec:** `docs/superpowers/specs/2026-11-11-mls-chat-design.md`.

## Global Constraints

- Never start, stop or restart port 8181.
- Plaintext rooms retain existing behavior.
- Encrypted rooms never fall back to plaintext.
- No Git metadata is available; do not create commits/worktrees.
- Fingerprints identify keys, not verified people.

## Tasks

- [x] Extend Rust/browser bindings with group/member descriptions and validate
  restored/joined room identity. Run native tests and regenerate bindings.
- [x] Write relay tests first: initialization, admission, version conflict,
  idempotency, plaintext rejection, pending removal and private Welcome
  delivery. Implement `server/mls-relay.js`, integrating routes/lifecycle
  into `server/index.js` without changing plaintext contracts.
- [x] Implement `src/mls-client.js`: serialized sync, IndexedDB snapshots,
  compare-and-set outbox recovery, approval/removal and message callbacks.
  Restore a pre-operation snapshot on a rejected public membership commit;
  preserve consumed sender generations for rejected application messages.
  Never regenerate
  a payload for a request with an uncertain result.
- [x] Add default checked creation input, immutable room-mode indicator,
  pending admission UI, approval buttons, fingerprint inspection and
  fail-closed composer. Connect existing lifecycle/notification behavior.
- [x] Run full Node/Rust tests, build, and actual non-localhost HTTP browser
  checks with independent browser contexts. Verify default/opt-out modes,
  approvals, send, refresh, leave and destruction. Stop temporary servers.
- [x] Update README with tested browser compatibility, build instructions,
  local-storage and HTTP limitations and bounded relay capacity.

## Critical Protocol Rules

Each accepted operation advances the relay revision. Every application,
admission and removal request supplies the revision it was based on and a
unique operation ID. The relay accepts a retry of an accepted ID before
checking revisions; a new operation with a stale revision returns 409.
Membership commits increment the epoch. Sending is blocked while an
admitted member awaits removal.

Persist tentative post-operation state plus the exact outbound payload and
the pre-operation state before POST. On acknowledgment, persist the
advanced cursor and clear the outbox before another operation. On uncertain
network failure retry the outbox unchanged. On definitive conflict restore
pre-operation state only for signed public membership commits. Preserve
the advanced application sender state, consume missed log entries and let
the user retry.
Do not replay one's accepted application message through MLS decryption.

The browser validates MLS sender identity against the authenticated
payload, group ID on Welcome, and its own membership after restore.
An applicant sees only its pending status and, once admitted, its own
Welcome. Other members cannot retrieve that Welcome through the log.

Keep at most 1,000 application ciphertexts; retain protocol metadata and
membership updates until expiry with hard total size/entry bounds.
An offline client missing trimmed ciphertext must rejoin rather than
pretending it processed that ciphertext. Local decrypted history is
explicitly endpoint storage, not encryption at rest.

## Execution Notes

Milestones were exercised on November 11, 2026. The browser suite also
verifies lost application/admission acknowledgments, competing
application/admission revisions, approval by a non-founder and local
cleanup isolation between identities in one browser profile.

An independent reviewer dispatch was attempted, but the available agent
transport returned an empty task payload and no code review took place.
The implementation has automated tests and manual source review, not
an independent cryptographic/security audit.
