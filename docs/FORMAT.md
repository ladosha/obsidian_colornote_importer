# ColorNote backup file format

This document describes the encrypted backup files that ColorNote for Android
writes. In the app's own backup folder they are named like
`1794696057346-MANUAL.backup` or `1794696057346-AUTO.backup` (the number is the
backup time in ms). Older app versions wrote the same kind of file to
`data/colornote/backup`, named like `1648016024853-AUTO.doc`. Copies taken out
of the app may have other names, such as `colornote-20261108.backup`.
Importers should not rely on the file name.

This document covers only what an importer needs. It is a functional
description of the file layout and of standard algorithms, written for
interoperability. It contains no code from ColorNote.

The importer in this repository was implemented from this document alone.

Notation: `u32`/`u64` are unsigned big-endian integers. Byte strings in quotes
are ASCII. "ms" means milliseconds since 1970-01-01T00:00:00Z.

## 1. File layout

| Offset | Size | Content |
|-------:|-----:|---------|
| 0  | 8 | Magic: the text `NOTE` in UTF-16BE: `00 4E 00 4F 00 54 00 45` |
| 8  | 4 | u32 format major version (observed: `7`, `8`, `9`) |
| 12 | 4 | u32 format minor version (observed: `1`, `2`) |
| 16 | 8 | u64 time the backup was made, in ms (UTC) |
| 24 | 4 | u32 number of active notes in the backup (informational only) |
| 28 | rest | Ciphertext (§2). Its length is a multiple of 16. |

Formats 7.1, 7.2, 8.1 and 9.1 have been verified against real backups.
ColorNote 4.9.4 writes 9.1. Formats 7.x and 8.x are laid out identically; 9.x
differs only in compression (§2.1). Other versions may exist. An importer should not reject a file only because of its version. It
should decrypt the same way, then fail with a clear message if the plaintext
does not parse. A file without the magic is not a ColorNote backup.

## 2. Backup encryption

* Cipher: AES-128 in CBC mode with PKCS#7 padding.
* IV: 16 zero bytes. (The IV is **not** derived from the password.)
* Key: `MD5(passwordBytes || "ColorNote Fixed Salt")`, which is 16 bytes. This
  is the first output block of OpenSSL's `EVP_BytesToKey` with MD5 and one
  iteration.
* Password: the user's ColorNote master password. If the user never set
  one, the app uses the password `0000`.
* `passwordBytes`: one byte per UTF-16 code unit of the password (the low 8
  bits of each code unit). For ASCII passwords this is the same as ASCII or
  UTF-8. This was verified with a real 9.1 backup whose password contains
  `æ` (U+00E6): the app uses the byte `E6`, not the UTF-8 bytes `C3 A6`.
  Characters above U+00FF (such as `ж`) have not been verified. Try the
  low-byte form first, then fall back to UTF-8.

A wrong password almost always produces invalid PKCS#7 padding. Rarely, the
padding happens to be valid, so a correct importer also requires the
plaintext to parse (§2.1, §3) before it accepts the password.

Test vector: for password `0000` the key is
`298b599af054ad5d0c7d80680419378b`.

### 2.1 Compression (format 9)

In format 9.x the plaintext layout of §3 is compressed before it is
encrypted. After decryption and removal of the PKCS#7 padding, the data is
a single **zlib stream** (RFC 1950: a 2-byte header, DEFLATE data per RFC 1951,
and an Adler-32 checksum) with nothing after it. Inflate it to get the §3
layout. Real 9.1 backups use a default zlib header (`78 9C`), and the data
inflates to about three times its compressed size.

Format 7.x and 8.x data is not compressed: the decrypted data is the §3
layout itself.

The two can be told apart from the decrypted data alone, which matters for
versions that have not been observed:

* §3 data starts with a u32 section kind, so its first byte is `00`.
* A zlib stream's first byte is never `00`. Its two header bytes, read as
  a big-endian u16, are a multiple of 31, and the low 4 bits of the first byte
  are `8` (DEFLATE).

Use the header version first: 9 means zlib, 8 means uncompressed. For any
other version, including 7, use the test above.

With a wrong password, the decrypted data is random. If its padding happens to
be valid, it almost never starts with a valid zlib header either. Treat an
invalid zlib header the same way as invalid padding: as a wrong password.
If the header is valid but the stream does not inflate completely, or its
checksum does not match, treat the file as damaged.

## 3. Plaintext layout

The plaintext (for format 9, the inflated data from §2.1) is a sequence of
**sections** that runs to the end of the data:

```
section := kind:u32  count:u32  record{count}
record  := length:u32  json:byte[length]      (UTF-8 JSON object, starts with "{")
```

Observed section kinds:

| Kind | Records | Content |
|-----:|---------|---------|
| 1 | 1 | The sync account record. It holds credentials such as `auth_token`. |
| 2 | many | Note records (§4) |

Ignore sections of any other kind, but still step over their records.

**The account record (kind 1) holds credentials. Never write, log or display
it.**

Parse strictly first. A lenient fallback is allowed for damaged or
unexpected files: at offset `p`, read `n = u32`. If `2 <= n <= remaining`, the
byte at `p+4` is `{`, and the `n` bytes parse as a JSON object, take it as a
record and continue at `p+4+n`. Otherwise advance `p` by 1. In lenient mode, a
record is a note record only if it has a numeric `type` and a string `note`.

## 4. Note records

Each note record is a flat JSON object. Every value is a JSON number or
string. Integers are plain JSON numbers. Read them defensively: a numeric
string or a boolean could appear in other versions.

| Field | Type | Meaning |
|-------|------|---------|
| `_id` | int | Local note id, unique within one backup. |
| `uuid` | string | Globally unique note id (UUID text). Stable across devices and backups. Use it as the note's identity. |
| `title` | string | Note title. May be empty. Never encrypted, even for locked notes. |
| `note` | string | Body. Plain text, not Markdown. Line breaks may be `\r\n`, `\r` or `\n`. For locked notes this is ciphertext (§5). |
| `type` | int | `0` text note, `16` checklist, `256` internal record (not a user note) |
| `active_state` | int | `0` active, `16` in trash, `32` deleted by the user (do not export), `256` internal/hidden (do not export) |
| `color_index` | int | `1` red, `2` orange, `3` yellow (the app's default), `4` green, `5` blue, `6` purple, `7` black, `8` gray, `9` white |
| `status` | int | Bit flags. Bit `16` (0x10) means the note is marked as checked/done (shown struck through in the app). Other bits seen (`4096`, `65536`, `131072`) have unknown meaning. Ignore them. |
| `encrypted` | int | `0` plain, `1` locked note (§5). Treat any truthy value as locked. |
| `created_date` | int | Creation time, ms (UTC) |
| `modified_date` | int | Last modification time, ms (UTC) |
| `reminder_date` | int | When the reminder is next due, ms (UTC). `0` means no pending reminder. `-1` marks a note pinned to the status bar. See §7. |
| `reminder_type` | int | The kind of reminder (§7). |
| `reminder_repeat` | int | How the reminder repeats (§7). |
| `reminder_repeat_ends` | int | When a repeating reminder stops, ms (UTC); `0` means never (§7). |
| `reminder_base` | int | When the reminder was first due, ms (UTC) (§7). |

Fields that exist but carry no information an importer needs: `folder_id`,
`space`, `importance`, `note_type`, `note_ext`, `tags`, `latitude`,
`longitude`, `account_id`, `dirty`, `staged`, `revision`,
`minor_modified_date`, `reminder_last`, `reminder_option` and
`reminder_duration`. Ignore them.

### Internal records

These are not user notes. Never export them:

* records with `type` 256 or `active_state` 256
* records titled `syncable_settings` (app settings) or `name_master_password`
  (key material: never write, log or display it)
* records without both a `note` and a `type` field

## 5. Locked notes

A note with `encrypted` = 1 was locked in the app. Its `note` field is
base64 (standard alphabet, no line breaks) of a ciphertext:

* Cipher: AES-256 in CBC mode with PKCS#7 padding. IV: 16 zero bytes.
* Key: a fixed 32-byte key that does not depend on the master password. It is
  derived with the PKCS#12 key derivation function (RFC 7292, Appendix B.2)
  using these parameters:
  * hash SHA-256 (u = 32, v = 64)
  * ID byte 1 (key material)
  * password `ColorNote Password`, encoded as a BMPString (UTF-16BE) followed by two zero bytes
  * salt: the ASCII bytes of `ColorNote Fixed Salt`
  * iteration count 20
  * output length 32 bytes
* Test vector: the key is
  `703b84c1fdc301cc5eb97fa793b8c03e5f3b0ae4207d40f6ad7d21e511938b35`.
* The plaintext is the UTF-8 note body. Line breaks may be `\r\n`, `\r` or
  `\n`, as in plain notes.

Because the key is fixed, a locked note is readable by anyone who holds the
decrypted backup. An importer writes these notes as plain text, so it should
mark which notes were locked.

## 6. Checklists

A checklist body (`type` 16) is one item per line:

* `[ ] text` is an unchecked item.
* `[V] text` is a checked item. Uppercase `V` has been observed. Accept lowercase too.

The marker is followed by one space. Lines without a marker (plain text) and
empty lines also occur. Keep them as they are.

## 7. Reminders

The facts in this section were observed in real 9.1 backups. Test notes were
given each kind of reminder and each repeat option in the app (ColorNote
4.9.4), a backup was made, and the decoded records were compared with what had
been chosen.

A note has a pending reminder when `reminder_date` is not `0`. When it is `0`,
export no reminder, whatever the other `reminder_*` fields say. They keep their
old values after a one-time reminder has gone off, or after the note was moved
to the trash.

### 7.1 Kinds

| `reminder_type` | Kind | `reminder_date` |
|---:|---|---|
| `0` | none | `0` |
| `16` | All day | 00:00:00 UTC of the reminder's calendar date. The date is the UTC date of the value, whatever the device's time zone was. |
| `32` | Time alarm | The moment the alarm goes off. The time the user chose is this moment in the device's local time zone. The seconds may be non-zero, for example after the app's "Remind me in 15 minutes". |
| `128` | Pinned to the status bar | `-1`. The note stays in the Android notification bar; it has no date and does not repeat. |

Other values have not been seen. If `reminder_date` is greater than `0` and
the type is not `16`, treat the reminder as a time alarm.

### 7.2 Repeat

`reminder_repeat` applies to all-day reminders and time alarms in the same
way. The repetition follows `reminder_base`, the first occurrence;
`reminder_date` is the next occurrence, already computed by the app. The
examples are the app's labels for a reminder first due on Sunday, 15 November
2026.

| `reminder_repeat` | Repeats | The app's label |
|---:|---|---|
| `0` | Never (one-time) | One-time event |
| `16` | Every day | Daily |
| `48` | Every week, on the same weekday | Weekly (every Sunday) |
| `64` | Every other week, on the same weekday | Bi-weekly (every other Sunday) |
| `80` | Every month, on the same weekday of the same week of the month | Monthly (every third Sunday) |
| `96` | Every month, on the same day of the month | Monthly (on day 15) |
| `112` | Every year, on the same date | Yearly (on November 15) |
| `128` | Every year, on the same date of the lunar calendar | Lunar (on lunar October 7) |

Other values, such as `32`, have not been seen. Treat them as unknown: keep
the reminder, but do not describe it as repeating.

`reminder_repeat_ends` is `0` when the repetition never ends. Otherwise the app
stores the last second of the chosen end date in the device's local time zone.
An end date of 30 November chosen at UTC+4 is stored as
`2026-11-30T19:59:59Z` (`1796068799000`). The end date is the local calendar
date of this value.

### 7.3 Example

A time alarm first due on 15 November 2026 at 14:46:47 at UTC+4, repeating
daily until 30 November:

```json
{
  "reminder_type": 32,
  "reminder_date": 1794739607000,
  "reminder_base": 1794739607000,
  "reminder_repeat": 16,
  "reminder_repeat_ends": 1796068799000
}
```

`1794739607000` is `2026-11-15T10:46:47Z`, 14:46:47 at UTC+4.
