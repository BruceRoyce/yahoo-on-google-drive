# Local checkpoint

Completed before Drive implementation on Windows x64, Bun 1.4.0 (34cbb9a40).

`bun run typecheck`: passed.
`bun test`: 8 tests passed, 51 assertions, no account connections.

Verified installed ImapFlow 2.10.0 and MailParser 3.14.1 under Bun; native
`bun:sqlite` and FTS5 operate successfully. Tests exercise byte preservation,
attachment decoding/hashes, header timezone retention, FTS/address/date search,
duplicate Message-IDs, folder membership, UIDVALIDITY changes, retry/resume,
backfill, dry-run, failed writes, immutable publication, explicit selection,
manifest verification and CSV/Markdown export.

The protocol integration test runs the real ImapFlow engine with an in-memory
synthetic server. It asserts verified-TLS configuration, EXAMINE, UID SEARCH,
UID FETCH, BODY.PEEK[], selectable folder discovery, and no mutation commands.
This is not an end-to-end TLS handshake or Yahoo interoperability test.

The execution sandbox blocks Windows hard-link publication (EPERM) and Bun's
package temporary-directory access (EBADF). Dependency installation and tests
were therefore run with approved execution outside that sandbox, on the same
Windows/Bun installation. No filesystem fallback weakens atomic publication.

No real credentials, accounts, correspondence, or Drive services are used.

## Final verification, including optional Drive

`bun run check`: passed on the same Windows/Bun installation: strict TypeScript
checking followed by 17 offline tests, 100 assertions. This includes the original
local checkpoint plus transaction rollback and rate-limit checks. Drive tests
cover explicit selection, dry-run isolation, confirmation refusal, local and
remote tampering, interrupted upload recovery, repeat-upload idempotency, PKCE,
state validation, a real loopback HTTP callback with a mocked token endpoint,
local token refresh storage, authenticated API requests, and rejecting malicious
upload redirect locations. The IMAP protocol test additionally verifies refusal
of an oversized message before any source retrieval.

CLI help and invalid calendar-date failure were also exercised. No live Yahoo or
Google interoperability was tested. Filesystem durability tests cover process
interruption/atomic publication, not destructive power-loss simulation. The
SQLite index and manifests are not cryptographically signed; protect and back up
the entire archive, not only the originals.

## Historical boundary revision

`bun run check`: passed on Windows/Bun 1.4.0: 23 offline tests, 142 assertions,
plus strict TypeScript checking. The default/configured inclusive start is now
2024-09-01, enforced using INTERNALDATE rather than the RFC Date header.

New regression coverage verifies server-side SINCE with the exact requested date
(no previous-day widening or SEARCH ALL), metadata validation before body fetch,
timezone-offset candidates before UTC midnight, invalid dates failing closed,
inclusive midnight, Inbox/Sent/custom folder coverage, incremental new messages,
CLI and environment boundary confirmation, remembered policy against backward
configuration edits, dry-run policy isolation, v1-to-v2 migration, and retention
of previously archived out-of-range messages. No real account access occurred.

## Writer lock recovery revision

Replaced the exclusive-create JSON marker with an OS-backed exclusive SQLite
transaction in a separate `.writer.sqlite` database. The lock database is never
deleted on release; process termination releases its lock automatically. Legacy
markers are retired only for demonstrably dead PIDs, under the new lock.
Filesystem failures are distinguished from lock contention.

`bun run check`: passed on Windows/Bun 1.4.0: 29 offline tests, 153 assertions,
plus strict typing. Added actual child-process contention/termination recovery,
persistent file reuse, live/dead legacy marker handling, malformed marker
preservation, filesystem-error classification, and action-failure cleanup.
