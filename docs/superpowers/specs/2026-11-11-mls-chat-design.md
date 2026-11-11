# Optional MLS Encrypted Rooms

## Scope

Add a room creation checkbox labelled "端到端加密（MLS）", checked by
default. Unchecking it creates an ordinary plaintext room with the existing
behavior. The encryption mode is immutable for the lifetime of a room.

This document describes the proposed implementation, not an implemented
security guarantee. No service should be started or restarted on port 8181
as part of development.

## Threat Model

For this iteration, assume the browser receives authentic application code.
Active modification of the HTTP-delivered frontend is explicitly outside
scope. Protect encrypted message contents from the relay server and network
observers, without claiming that HTTP becomes secure.

Room IDs, names, nicknames, membership, traffic timing and sizes, access
password submissions and bearer tokens remain outside message encryption.
A stolen bearer token must not by itself provide MLS private state or allow
the attacker to impersonate an existing cryptographic sender.

MLS credentials bind an ephemeral signing identity to protocol membership.
Random nicknames and server-issued member IDs are display/access identities,
not independently verified human identities. Admission approval alone is
not proof against a malicious relay substituting a new applicant's identity.
Provide identity fingerprints for verification through a trusted channel;
do not label unverified identities as verified.

## User Experience

- Encryption is checked by default on room creation.
- Show the immutable room mode to members and prospective joiners.
- Room passwords remain optional access controls, separate from MLS keys.
- Creating an encrypted room initializes its MLS group in the browser.
- An applicant waits until an existing online MLS member approves admission.
  No online member means waiting, not automatic admission or key escrow.
- An admitted member can approve subsequent applicants; there is no new
  permanent administrator role.
- A new member cannot read messages preceding admission. Do not implement
  history key sharing.
- Refresh restores the member's local protocol state. If that state is lost
  or unusable, require fresh admission rather than retrieving private keys
  from the server.
- Explicit leave removes the member from the cryptographic group before
  remaining members resume sending. Closing the tab is still not leaving.
- Preserve themes, online count, random nicknames, notifications, TTL,
  last-member destruction and the immediate ghost-button destruction.
- Errors never cause an encrypted room to send plaintext.

## Library and Compatibility Gate

Evaluate OpenMLS compiled to browser WASM with its supported cryptographic
provider. Do not implement MLS, a custom key exchange, or a replacement
shared-key protocol by hand.

Before integrating with the application, build an isolated compatibility
prototype. It must establish that the selected build works in a browser on
ordinary LAN HTTP, including secure random generation without a
Math.random fallback, required storage APIs and WASM loading.

The prototype must demonstrate three-party admission, authenticated
application messages, removal and state restoration. If the library cannot
meet the gate, report the precise blocker and seek approval for a revised
library/design. Do not silently substitute a different protocol.

## Architecture

Keep the existing Node HTTP and SSE transport. Plaintext rooms keep their
current interfaces. Encrypted rooms use separate protocol payloads and
reject plaintext message submissions on the server.

The browser MLS adapter owns identity generation, KeyPackages, group
creation, Welcome processing, commits, encryption/decryption, fingerprints
and state persistence. Private keys and message plaintext are never
included in API requests, logs or relay state.

Use per-room IndexedDB records associated with a tab-scoped session
identifier, allowing refresh recovery without intentionally sharing a
mutable MLS sender state across tabs. Serialize adapter operations within
the page and protect persistent state updates from competing instances.
Persist protocol state and processed-log position together. Persist an
outbound ciphertext before sending it so retry reuses the exact payload
instead of consuming another MLS sender generation.

The relay owns access tokens, admission requests, public KeyPackages,
recipient-targeted Welcomes and a sequenced protocol log. Retain protocol
updates for the room lifetime, separately from the last 1,000 application
ciphertexts; losing a required commit must not be treated as a valid sync.
Bound request sizes, pending applicants, group size and protocol-log growth;
exhaustion explicitly rejects new operations rather than truncating required
state or disabling encryption.

Serialize membership commits using a relay sequence/version precondition.
Only one change is accepted for a given version; rejected senders discard
their tentative change, catch up and retry. The sequence is a delivery
mechanism, not a source of cryptographic trust. Clients validate MLS
messages and sender credentials, not just server-supplied attribution.

Membership commits use MLS signed public handshake messages. Membership
metadata is already outside the confidentiality scope. This permits
discarding rejected tentative membership changes without rewinding an
encrypted handshake sender ratchet. Application messages are always
encrypted; a rejected application consumes its sender generation and
must not restore the earlier sender state.

Approve an applicant with one atomic relay operation containing the commit,
recipient Welcome and admission mapping. Pending applicants cannot receive
general room ciphertext history or submit application messages.

Leaving a group with remaining members requires a removal commit produced
by a remaining member. Revoke the leaving member's transport token
immediately and block new application messages until removal is committed.
If remaining members are offline, removal stays pending until one returns.
The last member leaving destroys the room without needing a removal commit.

## Failure and Lifecycle Rules

Process the protocol log in order before enabling sends. A missing update,
invalid signature, decryption error or inconsistent local state produces an
explicit error and stops affected operations; it is not a plaintext retry.

Keep the SSE protocol cursor separate from HTTP acknowledgments. Retries
are idempotent. Reconnection does not replay application operations against
already advanced MLS state.

Room destruction clears relay state, closes streams and clears active
clients' local room secrets and displayed messages as today. Offline local
records are cleaned up when that client next opens the application and
learns the room is gone. Do not claim remote erasure of offline devices,
copied plaintext or backups.

Forward secrecy depends on correct library use and deletion of obsolete
secrets. Post-compromise recovery requires an appropriate honest update
after the affected endpoint becomes safe; persistent device compromise
is not solved by MLS.

## Verification

1. Existing ordinary-room tests and production build continue passing.
2. Default checkbox is checked; opting out creates a plaintext room;
   mode cannot be changed and ciphertext rooms reject plaintext APIs.
3. Three independent browser contexts exchange messages after approval;
   the relay and captured requests contain no application plaintext or
   private group state.
4. Pending applicants cannot send or decrypt; newly admitted members
   cannot decrypt pre-admission messages.
5. A removed member retaining its old keys cannot decrypt post-removal
   messages. Sending is blocked while removal is pending.
6. Concurrent approvals, send/commit races and lost acknowledgments
   converge without duplicate admission or key-state corruption.
7. Refresh and disconnect/reconnect recover committed state; corrupted or
   deleted state requires re-admission without plaintext fallback.
8. Modified ciphertext and forged sender attribution are rejected.
9. Browser checks run on an actual non-localhost HTTP origin, plus desktop
   and mobile layouts, without manipulating the user's 8181 service.
10. TTL, ghost destruction, final explicit leave and local-secret cleanup
    work for both room modes.

## Delivery

First deliver the isolated compatibility result. Only after that gate
passes, integrate the adapter, relay changes and room-mode UI. Update the
README with actual tested compatibility and explicit security limitations.
This repository currently has no Git metadata, so the design can be saved
locally but cannot be committed here.
