# Evidence archive design

The CLI is local only. Modules separate configuration, read-only IMAP transport,
MIME parsing, immutable object storage, SQLite indexing, synchronization, search,
exports, and optional Drive upload. Tests use synthetic correspondence and services.

## Layout

`src/` implementation; `tests/` offline tests and synthetic fixtures.
`data/index.sqlite` metadata and FTS5; `data/objects/` content-addressed originals;
`data/attachments/` decoded attachment derivatives; `data/collections/` completed
exports; `data/private/` local OAuth tokens; `data/.writer.lock` single-writer lock.

## Schema

Accounts use SHA-256(host, port, normalized login). Mailboxes use account + exact
server path, with every observed UIDVALIDITY retained. Messages use original byte
SHA-256, never Message-ID, as identity. Occurrences have unique
(mailbox, UIDVALIDITY, UID), preserving folder membership and old generations.
An occurrence records INTERNALDATE independently of the RFC Date header, its UTC
parse, and the original raw Date header. Attachments record position, original
untrusted filename, MIME type, decoded-byte hash and safe local path. FTS5 indexes
subject, addresses, and extracted body text. No source data is removed on server
deletion, folder disappearance, or UIDVALIDITY rollover.

## Synchronization and crash recovery

Use TLS verification, EXAMINE/readOnly, UID SEARCH and BODY.PEEK[] exclusively.
Discover selectable folders, including custom folders; sync all by default.
Enumerate server UIDs each run and compare occurrences in the selected generation;
do not use a high-water mark that could skip failed downloads or earlier backfills.
`MAIL_ARCHIVE_SINCE` defaults to the inclusive minimum 2024-09-01. Every folder
uses UID SEARCH SINCE at the accepted boundary without broadening it. Fetch
INTERNALDATE and size as metadata first; only issue BODY.PEEK[] if INTERNALDATE
is at or after UTC midnight at the boundary. Invalid/missing INTERNALDATE fails
closed. Header Date never determines eligibility. SINCE itself uses IMAP calendar
date semantics; the UTC metadata check further restricts candidates.

Schema v2 adds account-specific `sync_boundaries` policy, preserving all v1 data.
Before account access, require explicit confirmation for a start earlier than
the maximum of default minimum, configured start, and last non-dry-run start.
Remember accepted starts before body retrieval so partial runs cannot silently
relax the boundary later. Dry-run does not update policy. Initial backfill and
incremental updates enumerate the same bounded range, retaining all old evidence
and folder memberships regardless of eligibility. No deletion mirroring.

Rate-limit requests. Retry failed folders with a new authenticated connection,
reselect and read UIDVALIDITY before trusting UIDs. Commit each complete message
individually, so retries skip completed work. Atomically publish original and
attachment objects before one SQLite transaction inserts metadata, FTS, and source
occurrence. Existing objects must match their content hashes. A crash can leave
unreferenced objects but never a successful row pointing to a partial download.
Objects are write-once and read-only on disk; SHA verification detects tampering.
This is application-level immutability, not tamper-proof/WORM storage.

Exports require explicit local message IDs. A staged collection contains originals,
decoded attachments, inert Markdown text, CSV/JSON index and manifest with file
hashes and full provenance; atomic directory rename publishes it. Existing
collections are never overwritten. Search output contains private data by request;
ordinary progress/error logs use fixed event names and numeric counts only.

## Verification checkpoint

Complete and test the local system before implementing Drive. Drive accepts only
explicit, verified collections, uses the drive.file OAuth scope, requires typed
confirmation for each upload, and never selects correspondence automatically.
