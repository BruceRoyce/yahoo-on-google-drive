# Yahoo evidence archive

A local-only TypeScript/Bun CLI for archiving Yahoo Mail and selecting evidence.
Original RFC 822 bytes are stored separately from searchable text and decoded
attachments. SQLite uses Bun's native `bun:sqlite` with FTS5. No HTTP service
serves the archive. Read [DESIGN.md](DESIGN.md) for the schema and recovery model.

## Install on Windows

Use Bun 1.4.0 or later and an NTFS local disk (atomic hard-link publication is
required). From PowerShell in this folder:

```powershell
bun install --frozen-lockfile
bun run check
Copy-Item .env.example .env
notepad .env
```

Configure `YAHOO_USER` and a Yahoo-generated app password in `.env` locally.
Never send credentials in chat. Bun loads `.env` automatically. TLS verification
is always enabled; defaults are `imap.mail.yahoo.com:993`. `ARCHIVE_DIR` defaults
to `./data`. Protect the directory with your Windows account's NTFS permissions
and disk encryption. SQLite, exports, and message bodies are not encrypted by
this application. Keep them outside public/shared or automatically synced folders.

## Archive and update

```powershell
bun mail:folders
bun mail:sync --dry-run
bun mail:sync
bun mail:sync --since 2024-09-01
bun mail:sync --folder INBOX --folder Sent
bun mail:verify
```

Use the exact folder names from `mail:folders`; Yahoo may use a different Sent
name. Sync archives all selectable folders, including historical
Inbox, Sent, Archive, custom folders, and any selectable Spam/Trash folders.
Use repeated `--folder` to restrict this. Initial backfill and incremental updates
use the same command. By default, **only messages from 1 September 2024 inclusive**
are eligible. Set `MAIL_ARCHIVE_SINCE=2024-09-01` in `.env` to configure the start
date, or use `--since YYYY-MM-DD` for a particular run. Sync uses INTERNALDATE,
not the sender's Date header; the original Date header is preserved independently.
Every folder, including Sent, uses server-side `UID SEARCH SINCE <date>` with no
earlier-day widening or unbounded fallback. Before downloading a body, a
metadata-only fetch also checks INTERNALDATE against UTC midnight on that date.
IMAP SINCE matches the calendar date of INTERNALDATE (ignoring its timezone);
the additional UTC check excludes candidates whose offset puts them before the
boundary. No pre-boundary bodies or attachments are downloaded or archived.

An earlier start than the configured date, the last non-dry-run sync start for
that account, or 1 September 2024 requires interactive typed confirmation:
`ARCHIVE FROM YYYY-MM-DD`. This also applies to earlier dates set in `.env` and
to dry-runs; there is no unattended confirmation bypass. Dates before the default
minimum require confirmation on every run. A later configured date is remembered
before retrieval starts, so even after a partial sync changing it backwards
cannot silently expand the range. A later run can backfill eligible missing UIDs
from the accepted boundary onwards. Existing out-of-range evidence is never
deleted, hidden from local search, or removed from its recorded folder history.

Dry-run authenticates and enumerates candidate UIDs without
downloading messages or recording mailbox generations (it may initialize an
empty index and transient writer lock). Its pending count is an estimate before
the metadata boundary check; it does not change the remembered sync boundary.

Originals are hash-addressed `.eml` files. Each folder occurrence records its
account, exact mailbox, UID, UIDVALIDITY and INTERNALDATE. Duplicate Message-IDs
are not treated as identity. Identical raw bytes share an object while preserving
all source occurrences. UIDVALIDITY rollover retains old evidence. Server-side
deletion is never propagated to the local archive. A vanished UID is reported
and revisited by later enumeration. IMAP is opened read-only; retrieval uses
BODY.PEEK[]. No sending, flag changes, moving, deleting, or expunging is supported.

Each message commits after its original and attachments are fully published.
Interruptions can leave unreferenced objects or hidden `.staging-*` export
directories; these are never treated as completed evidence. Retry uses a fresh
connection, reselects the folder, and skips completed occurrences. Failed folders
produce a nonzero exit; rerun to resume. The default message cap is 100 MiB;
adjust `MAX_MESSAGE_BYTES` locally for larger messages. MIME parsing buffers one
message and its attachments in memory. Parser failures retain the raw orphan
object and leave the UID pending rather than claiming indexing succeeded.

## Search and explicitly export

```powershell
bun mail:search --query "water ingress"
bun mail:search --address "landlord@example.com" --since 2024-09-01 --until 2025-01-01
bun mail:search --subject "repair" --limit 100 --offset 0
bun mail:export --case beaconsfield --ids 1,3,7
```

Search outputs JSON including local IDs and source memberships. Query terms are
literal FTS tokens combined with AND, rather than arbitrary FTS syntax. Address
and subject filters are case-insensitive substrings. Search dates use the parsed
RFC Date in UTC; `--until` is exclusive. Missing/invalid Dates stay searchable by
other fields but are excluded from date filters. Search is paginated (default
100; maximum 10,000); use `--offset` to see more. Output contains private data;
do not redirect it to a public location or include it in issue reports.

Exports require explicit numeric IDs; there is no automatic whole-mailbox export.
The printed collection path under `data/collections/<case>/<collection>/` contains:

- `originals/`: byte-exact `.eml` evidence.
- `documents/`: inert text Markdown and JSON derivatives with source relationships.
- `attachments/`: decoded-byte files with generated `.bin` names; original names
  remain in JSON and the manifest, never as filesystem paths.
- `index.csv` and `index.json`: searchable analysis indexes (CSV formula cells are
  prefixed with an apostrophe; JSON retains exact text).
- `manifest.json` and `manifest.sha256`: provenance and SHA-256 of each payload,
  source mailbox/UID/UIDVALIDITY, original filenames, dates and attachment hashes.

Collection creation never overwrites a completed export. `mail:verify` verifies
database integrity, FTS consistency and every indexed original/attachment hash.
The original Date field including its timezone offset remains in the `.eml` and
`date_raw`; UTC is a separate derivative. ImapFlow normalizes INTERNALDATE to a
Date, so `internal_date_raw` is its library representation, not the original IMAP
wire string. The exact INTERNALDATE instant is retained separately in UTC.

## Optional Google Drive connection and selected upload

Complete a local sync, search, export, and `bun mail:verify` first. In Google
Cloud Console, enable Drive API, configure an OAuth consent screen, and create
an OAuth **Desktop app** client. Configure `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in your local `.env`. For an external app in Testing,
add your own account as a test user; Google may expire its refresh token after
seven days, requiring reconnection.

```powershell
bun mail:drive-connect
bun mail:drive-folder --name "County Court evidence"
# Set the returned GOOGLE_DRIVE_FOLDER_ID in .env.
bun mail:drive-upload --case beaconsfield --collection <printed-collection-name> --dry-run
bun mail:drive-upload --case beaconsfield --collection <printed-collection-name>
```

Open the printed authorization URL in your system browser. The three-minute
OAuth callback listener binds only to `127.0.0.1` on a random port, receives an
authorization code protected by state and PKCE, and then closes. It never serves
email or archive files. Tokens stay in `data/private/google.token.json`, protected
by the archive directory's Windows permissions; this file is not encrypted by
the app. Do not share it or include it in issue reports. Back up private tokens
only to an encrypted destination, or reconnect after restoring an archive.

The only scope is `drive.file`: access to files created by or explicitly opened
with this app. The folder command creates a new app-accessible private folder
and asks for typed confirmation. An arbitrary existing folder ID may be
inaccessible under this scope; use an app-created folder. No broader Drive scope
is requested, and no files or permissions are shared by the application. Avoid
destinations with inherited sharing; this app does not audit parent permissions.

Every upload requires an exact case, exact completed collection name, and a fresh
typed confirmation naming the destination. There is no `--yes` bypass or latest
collection default. Review local `index.json`/Markdown before confirming. Only
manifest-listed payloads plus the manifest and checksum are uploaded; unrelated
mail and extra local files are excluded. Dry-run performs local verification
without reading OAuth tokens, contacting Google, or creating a cloud folder.

The app creates one collection subfolder; payload filenames flatten `/` to `__`
while preserving the collection's logical paths in the manifest. It generates
and saves Drive file IDs before creating files. Repeating an upload verifies
existing IDs and skips matching files; mismatches fail rather than overwrite.
Resumable HTTP upload sessions transfer complete files, with safe whole-file
retry after interruption; partial byte offsets are not persisted. Remote content
is checked with Drive's MD5 checksum and byte count for transfer verification;
the evidence SHA-256 remains in the manifest and file properties. Upload state
under `private/uploads/` must accompany backups to retain cloud idempotency.
Revoking access in your Google account stops future uploads; it does not remove
already uploaded evidence. Delete cloud copies manually if appropriate.

Official protocol references: [ImapFlow fetching](https://imapflow.com/docs/guides/fetching-messages/),
[MailParser](https://nodemailer.com/extras/mailparser),
[Bun SQLite](https://bun.sh/docs/runtime/sqlite),
[Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
and [Drive upload and generated IDs](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

## Backup and recovery

Stop all commands, then back up the entire `ARCHIVE_DIR`, including the SQLite
database and any `-wal`/`-shm` files. Use an encrypted offline backup, preserve
permissions, and run `bun mail:verify` after restoration. Originals alone do not
contain folder/UID provenance; keep the index and manifests. Do not edit evidence
files. Hash manifests detect changes but are not signed or independently dated;
this provides application-level immutability, not WORM storage or proof of an
email's authenticity. Maintain a separate record of collection and handling.

Only one CLI command may hold `.writer.lock`. After a crash, confirm that no
archive command/process is running before manually removing that lock file.
Never remove it while a writer is active. Do not run from a network filesystem
or cloud-sync folder. Working directories and backups contain sensitive evidence.

## Development and security

`bun run check` runs strict typing and offline synthetic tests. No test accesses
real accounts. [VERIFICATION.md](VERIFICATION.md) records the local checkpoint.
Dependency versions are pinned in `package.json` and `bun.lock`. Progress/error
logs contain fixed event names and numeric counts, never server errors, subjects,
credentials, or message bodies. Exit 1 indicates failure or incomplete sync.
The CLI treats email contents as untrusted: no HTML UI, external resource loading,
attachment execution, or commands derived from email. Markdown bodies are
indented code text. JSON data remains untrusted input for downstream tools; do
not let analysis tools follow instructions embedded in correspondence.

`.gitignore` excludes credentials, archive data, tokens, originals, and exports.
If you change `ARCHIVE_DIR`, put it outside the repository or add its path to
`.gitignore` before archiving. Never commit correspondence or evidence bundles.
