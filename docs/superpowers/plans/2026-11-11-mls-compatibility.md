# MLS Compatibility Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prove that OpenMLS can support this application's encrypted rooms on ordinary LAN HTTP before changing the live chat.

**Architecture:** An isolated Rust crate wraps a pinned OpenMLS release and its RustCrypto provider. The same core runs native tests and browser WASM tests. Existing application routes and UI remain untouched until the compatibility gate passes.

**Tech Stack:** Rust, OpenMLS 0.8.3, wasm-bindgen, JavaScript, existing Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-11-mls-chat-design.md`.

## Global Constraints

- Default final room mode is MLS; an unchecked checkbox opts into plaintext.
- No service should be started or restarted on port 8181.
- Never replace MLS with custom cryptography or downgrade to plaintext.
- Native success is not proof of non-localhost HTTP browser compatibility.
- No Git repository exists here; use the isolated `mls-prototype/` directory.
- This is the compatibility milestone, not completion of the complete encrypted-room feature.

## Task 1: Establish a Reproducible MLS Core

**Files:** `mls-prototype/Cargo.toml`, `mls-prototype/src/lib.rs`,
`mls-prototype/tests/group.rs`, `mls-prototype/.gitignore`.

**Interface:** `Client::new(identity)`, `create_group(group_id)`,
`key_package()`, `add_member(key_package) -> Admission { commit, welcome }`,
`join(welcome)`, `process(message) -> Option<Application { sender, bytes }>`,
`encrypt(bytes)`, `remove_member(identity)`, `snapshot()` and
`Client::restore(snapshot)`. Methods return errors for malformed input.

- [ ] Add a pinned dependency manifest and native integration tests first.
  The tests use Alice, Bob and Carol, independent cryptographic providers
  and literal messages. An empty library must fail to satisfy the API.
- [ ] Run `cargo test --manifest-path mls-prototype/Cargo.toml`.
  Observe missing implementation, not silently skipped tests.
- [ ] Implement the interface with OpenMLS operations, TLS serialization,
  authenticated sender extraction, ratchet-tree Welcome support and provider
  storage serialization. No handwritten encryption.
- [ ] Verify Alice/Bob exchange; Carol joins without decrypting an earlier
  epoch; Bob is removed and cannot read a later message; tampered bytes
  fail; snapshot restoration processes a subsequent message.
- [ ] Pin transitive dependencies in Cargo.lock and record the tested
  versions. Do not commit: this directory has no Git metadata.

Test shape:

```rust
let mut alice = Client::new("alice")?;
alice.create_group("test-room")?;
let mut bob = Client::new("bob")?;
let admission = alice.add_member(&bob.key_package()?)?;
bob.join(&admission.welcome)?;
let ciphertext = alice.encrypt(b"first secret")?;
let message = bob.process(&ciphertext)?.expect("application message");
assert_eq!(message.sender, "alice");
assert_eq!(message.bytes, b"first secret");
```

## Task 2: Exercise the Same Core in a Browser

**Files:** `mls-prototype/src/lib.rs` (WASM exports),
`mls-prototype/browser/index.html`, `mls-prototype/browser/check.js`,
`mls-prototype/serve.mjs`, `mls-prototype/README.md`.

**Interface:** WASM exposes JSON-safe results and byte arrays around the
same `Client`. A browser harness runs the native scenario and reports
named results. A temporary Node server binds a non-8181 test port.

- [ ] Add the browser scenario before the WASM exports; record failure
  when the generated module is absent.
- [ ] Install the WASM compilation target and matching binding generator
  only with applicable filesystem/network approval.
- [ ] Compile with `cargo build --manifest-path mls-prototype/Cargo.toml
  --target wasm32-unknown-unknown --release`, then generate web bindings.
- [ ] Load the harness on a non-localhost HTTP address and assert
  `window.isSecureContext === false`. Verify cryptographic randomness,
  IndexedDB roundtrip and the MLS scenario, including serialization and
  restoration. Never expose private snapshots through an HTTP endpoint.
- [ ] Stop the temporary server and document actual results and limits.
  If tooling or runtime fails, record the exact blocker without declaring
  the compatibility gate passed.

## Task 3: Regression and Gate Review

**Files:** `mls-prototype/README.md`, this plan.

- [ ] Run `npm test` and `npm run build` for the unchanged app.
- [ ] Run the complete native MLS tests and browser scenario again.
- [ ] Mark only observed results complete. If the gate passes, write the
  integration plan covering immutable room modes, approved admission,
  ordered protocol transport, persistent browser state, explicit removal,
  fail-closed UI and existing lifecycle regression coverage.
- [ ] Report prototype status distinctly from the final encrypted-room
  feature. Do not enable a checkbox claiming encryption before integration.
