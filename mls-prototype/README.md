# OpenMLS Adapter and Compatibility Probe

This directory started as an isolated compatibility prototype. Its Rust
adapter is now also the source of `src/mls-wasm/`, used by encrypted rooms.
It is a first implementation, not an independently audited messenger.

## Rebuild

Normal application builds use the included generated WASM and JS bindings;
Rust is not required for `npm install`, `npm run build` or `npm start`.

To modify the cryptographic adapter, install a Rust toolchain compatible
with Cargo.lock, then:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100 --locked
npm run test:mls
npm run build:mls
npm run build
```

`MLS_WASM_BINDGEN` may point to the matching binding-generator executable.
The build also recognizes the local Windows download in `tools/`.
Generated `src/mls-wasm/` files must be distributed with the source.
Do not distribute `target/` or `tools/`.

Pinned direct cryptographic dependencies: OpenMLS 0.8.3, RustCrypto provider
0.5.1, basic credentials 0.5.0 and traits 0.5.0. Cargo.lock fixes transitive
versions. Ed25519, X25519, ChaCha20-Poly1305 and SHA-256 are supplied by
the library, not implemented here.

## Verification

`npm run test:mls` checks authenticated encryption, three-party membership,
pre-admission history exclusion, removal, tampering, replay rejection,
serialized state restoration and public signed membership handshakes.

The following scripts use Playwright with installed Chrome and a
non-loopback IPv4 address. Install Playwright in a separate tooling
environment, or pass the path to its package as the final argument.
Both scripts start random test ports and clean up their own servers.

```sh
node mls-prototype/verify-app.mjs /path/to/playwright
node mls-prototype/verify-browser.mjs /path/to/playwright
```

For the isolated probe, generate an additional copy of the bindings:

```sh
wasm-bindgen --target web --out-dir mls-prototype/pkg mls-prototype/target/wasm32-unknown-unknown/release/lan_chat_mls_prototype.wasm
```

On November 11, 2026, the isolated probe passed in Chrome on an actual
non-localhost HTTP origin at desktop 1280x800 and mobile 375x812 sizes.
It asserts `isSecureContext === false`, disables Math.random during
cryptographic operations and exercises IndexedDB state restoration.
This is not testing on a physical phone, Firefox or Safari.

The app test covers independent browser contexts, approval, no old history
for new members, refresh, ciphertext-only relay traffic, membership
removal, destruction, plaintext opt-out and mobile overflow.
It also covers lost application/admission acknowledgments, concurrent
application/admission version conflicts, non-founder approval and local
cleanup isolation for two identities in the same browser profile.
Refer to the execution report/command output for the most recent results.

## Security Notes

Application messages are encrypted MLS PrivateMessages. Membership
changes are signed MLS PublicMessages; membership metadata is not hidden.
Rejected application ciphertexts still consume sender generations.
Only rejected public membership changes restore a pre-operation snapshot.
Uncertain HTTP outcomes retry an identical persisted outbox payload.

Snapshots include private keys. Keep them exclusively on the endpoint.
The browser stores local decrypted history for refresh recovery, so this
is not encryption at rest. IndexedDB deletion is logical cleanup, not
guaranteed forensic erasure of browser storage or RAM.
