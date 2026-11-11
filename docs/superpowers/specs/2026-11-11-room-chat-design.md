# Temporary Room Chat

Approved scope: replace the shared document with plain-text group chat.

- Keep room creation, passwords, fixed lifetime and in-memory storage.
- Remove idle cleanup. Explicit leave revokes a member's token, tickets and
  streams; the last member's explicit leave immediately destroys the room.
  Disconnecting, closing a page or refreshing does not remove membership.
  Rooms with members who never explicitly leave survive until fixed expiry.
- Default to dark theme, offer light/dark controls throughout the app and
  remember the selected theme in browser storage. Apply it before page paint.
- Assign a unique random nickname and member ID on create/join. The room token
  identifies the same member on refresh. Leaving removes the local token.
- Use HTTP to submit messages and SSE to distribute ordered messages.
- Return room metadata, the authenticated member and retained history on load.
- On every SSE connection, send retained messages after the client's last ID,
  then subscribe to live messages without a gap. Clients deduplicate by ID.
- Messages have an increasing room-local ID, member ID, nickname, text and time.
- Limit messages to 2,000 characters and retain the latest 1,000 per room to
  bound memory. Tell users about the history limit.
- Render messages as text, preserve newlines, distinguish self from others,
  and retain unsent input on send failure.
- No files, private messages, accounts, editing, deletion or persistence.

Validation: real HTTP/SSE integration tests for identity, authorization, ordered
messages, reconnect replay, deduplication and validation; production build and
desktop/mobile browser checks for the create/join/send/refresh workflow.
