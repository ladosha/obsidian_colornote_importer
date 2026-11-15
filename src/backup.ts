// Decoding of ColorNote backup files (docs/FORMAT.md). Pure: no Obsidian
// imports, Web APIs only (WebCrypto, TextEncoder/TextDecoder, Compression
// Streams), so it runs in Obsidian (desktop and mobile) and in Node.

import { aesCbcDecrypt, aesCbcDecryptFirstBlock, aesCbcDecryptRaw, importAesKey } from "./crypto/aes";
import { md5 } from "./crypto/md5";
import { bmpString, pkcs12Kdf } from "./crypto/pkcs12";
import { inflateZlib, isZlibHeader } from "./zlib";

/**
 * Why a backup cannot be read. `unsupported-platform`: the backup is
 * compressed (FORMAT.md §2.1) and this platform has no zlib decompressor.
 */
export type BackupErrorCode = "not-colornote" | "wrong-password" | "damaged" | "unsupported-platform";

/** A backup that cannot be read. `message` is written for the user. */
export class BackupError extends Error {
	readonly code: BackupErrorCode;

	constructor(code: BackupErrorCode, message: string) {
		super(message);
		this.name = "BackupError";
		this.code = code;
	}
}

/**
 * How a reminder repeats (FORMAT.md §7.2). `monthly-weekday`: every month on
 * the same weekday of the same week of the month. `monthly-day`: every month
 * on the same day of the month. `lunar-yearly`: every year on the same date of
 * the lunar calendar.
 */
export type ReminderRepeat =
	| "daily"
	| "weekly"
	| "biweekly"
	| "monthly-weekday"
	| "monthly-day"
	| "yearly"
	| "lunar-yearly";

/** A time alarm or an all-day reminder (FORMAT.md §7.1). */
export interface DatedReminder {
	kind: "time" | "all-day";
	/**
	 * When it is next due, ms (UTC). For a time alarm, the moment the alarm
	 * goes off. For an all-day reminder, 00:00 UTC of its date: the
	 * reminder's date is the UTC date of this value.
	 */
	date: number;
	/** How it repeats; null when it is one-time or its repeat value is not known. */
	repeat: ReminderRepeat | null;
	/**
	 * When the repetition ends, ms (UTC): the last second of the end date in
	 * the time zone of the device that set it. 0 when it never ends or does
	 * not repeat.
	 */
	repeatEnds: number;
}

/** A note pinned to the Android status bar: no date, no repeat (FORMAT.md §7.1). */
export interface StatusBarReminder {
	kind: "status-bar";
}

/** A pending reminder (FORMAT.md §7). */
export type Reminder = DatedReminder | StatusBarReminder;

export type ReminderKind = Reminder["kind"];

/** One exportable note (active or in the trash), normalised. */
export interface BackupNote {
	/** `_id`: local id, unique within one backup (0 if missing). */
	id: number;
	/** `uuid`, trimmed; "" if missing. */
	uuid: string;
	/** `title` exactly as stored (not trimmed). */
	title: string;
	/** Plain-text body, decrypted for locked notes; line endings as stored. */
	body: string;
	isChecklist: boolean;
	inTrash: boolean;
	colorIndex: number;
	locked: boolean;
	/** Locked note whose body could not be decrypted; `body` is "". */
	lockedDecryptFailed: boolean;
	/** Status bit 16: marked as checked/done. */
	checked: boolean;
	/** Times in ms since the epoch (UTC); 0 when missing. */
	created: number;
	modified: number;
	/** The pending reminder; null when there is none. */
	reminder: Reminder | null;
}

export interface SectionInfo {
	kind: number;
	records: number;
}

export interface DecodedBackup {
	/** [major, minor] from the header. */
	formatVersion: [number, number];
	/** When the backup was made, ms since the epoch (UTC). */
	createdAt: number;
	/** The header's active-note count (informational only). */
	headerNoteCount: number;
	/** Exportable notes (active and trash) in backup order. */
	notes: BackupNote[];
	/** Section kinds and record counts; empty if the file was read leniently. */
	sections: SectionInfo[];
	/** True when the strict parse failed and notes were recovered leniently. */
	recovered: boolean;
	/** Records that are not exported, by reason (counts only). */
	excluded: { internal: number; deleted: number; other: number };
	/** Which password byte encoding opened the file. */
	passwordEncoding: "low-byte" | "utf-8";
}

const MAGIC = [0x00, 0x4e, 0x00, 0x4f, 0x00, 0x54, 0x00, 0x45]; // "NOTE" in UTF-16BE
const HEADER_SIZE = 28;
const DEFAULT_PASSWORD = "0000";
const FIXED_SALT = "ColorNote Fixed Salt";
const LOCKED_NOTE_PASSWORD = "ColorNote Password";
const NOTES_SECTION = 2;
/** Decrypted when probing a compressed backup whose padding failed: enough for the first records. */
const ZLIB_PROBE_BYTES = 4096;

const DAMAGED_MESSAGE = "The password is correct, but the backup file is damaged or incomplete, so it cannot be read.";

const TYPE_CHECKLIST = 16;
const TYPE_INTERNAL = 256;
const STATE_ACTIVE = 0;
const STATE_TRASH = 16;
const STATE_DELETED = 32;
const STATE_INTERNAL = 256;
const INTERNAL_TITLES = new Set(["syncable_settings", "name_master_password"]);

const REMINDER_ALL_DAY = 16;
const REMINDER_STATUS_BAR = 128;
/** The `reminder_date` of a note pinned to the status bar. */
const STATUS_BAR_DATE = -1;
/** `reminder_repeat` values (FORMAT.md §7.2). 0 is one-time; other values are unknown. */
const REMINDER_REPEATS: ReadonlyMap<number, ReminderRepeat> = new Map([
	[16, "daily"],
	[48, "weekly"],
	[64, "biweekly"],
	[80, "monthly-weekday"],
	[96, "monthly-day"],
	[112, "yearly"],
	[128, "lunar-yearly"],
]);

const utf8Lenient = new TextDecoder("utf-8");
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function ascii(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** One byte per UTF-16 code unit: the low 8 bits (FORMAT.md §2). */
export function passwordLowBytes(password: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(password.length);
	for (let i = 0; i < password.length; i++) out[i] = password.charCodeAt(i) & 0xff;
	return out;
}

/** The AES-128 backup key: MD5(passwordBytes || "ColorNote Fixed Salt"). */
export function backupKey(passwordBytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const salt = ascii(FIXED_SALT);
	const input = new Uint8Array(passwordBytes.length + salt.length);
	input.set(passwordBytes);
	input.set(salt, passwordBytes.length);
	return md5(input);
}

let lockedKeyBytes: Promise<Uint8Array<ArrayBuffer>> | undefined;
let lockedCryptoKey: Promise<CryptoKey> | undefined;

/** The fixed AES-256 key for locked notes (FORMAT.md §5). */
export function lockedNoteKey(): Promise<Uint8Array<ArrayBuffer>> {
	lockedKeyBytes ??= pkcs12Kdf(1, bmpString(LOCKED_NOTE_PASSWORD), ascii(FIXED_SALT), 20, 32);
	return lockedKeyBytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

function u32(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/**
 * How the decrypted data is stored (FORMAT.md §2.1): by the header's major
 * version, 9 compressed and 8 not; for any other version, told from the data.
 */
type Compression = "zlib" | "none" | "detect";

function compressionOf(major: number): Compression {
	if (major === 9) return "zlib";
	if (major === 8) return "none";
	return "detect";
}

/**
 * The test of FORMAT.md §2.1 for versions other than 8 and 9: §3 data starts
 * with a u32 section kind, so with 00; a zlib stream never does.
 */
function isCompressed(decrypted: Uint8Array, compression: Compression): boolean {
	if (compression === "detect") return decrypted.length > 0 && decrypted[0] !== 0;
	return compression === "zlib";
}

/**
 * Decodes and decrypts a ColorNote backup.
 * @param password the master password; "" means none was set (uses "0000")
 * @throws BackupError with code `not-colornote`, `wrong-password`, `damaged`
 *   or `unsupported-platform`
 */
export async function decodeBackup(data: Uint8Array, password: string): Promise<DecodedBackup> {
	if (data.length < MAGIC.length || !MAGIC.every((b, i) => data[i] === b)) {
		throw new BackupError("not-colornote", "This file is not a ColorNote backup.");
	}
	if (data.length < HEADER_SIZE) {
		throw new BackupError("damaged", "The backup file is incomplete: it ends inside the header.");
	}
	const formatVersion: [number, number] = [u32(data, 8), u32(data, 12)];
	const createdAt = u32(data, 16) * 0x100000000 + u32(data, 20);
	const headerNoteCount = u32(data, 24);
	const compression = compressionOf(formatVersion[0]);
	const version = `${formatVersion[0]}.${formatVersion[1]}`;

	const ciphertext = data.slice(HEADER_SIZE);
	if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
		throw new BackupError(
			"damaged",
			"The backup file is damaged or incomplete: its encrypted part has the wrong length.",
		);
	}

	const text = password === "" ? DEFAULT_PASSWORD : password;
	const candidates: { encoding: DecodedBackup["passwordEncoding"]; bytes: Uint8Array }[] = [
		{ encoding: "low-byte", bytes: passwordLowBytes(text) },
	];
	const utf8 = new TextEncoder().encode(text);
	if (!sameBytes(utf8, candidates[0].bytes)) candidates.push({ encoding: "utf-8", bytes: utf8 });

	// Set when a password candidate is right but the file still cannot be read.
	let failure: BackupError | undefined;
	for (const candidate of candidates) {
		const key = await importAesKey(backupKey(candidate.bytes));
		let decrypted: Uint8Array<ArrayBuffer> | undefined;
		try {
			decrypted = await aesCbcDecrypt(key, ciphertext);
		} catch {
			decrypted = undefined; // invalid padding: most likely the wrong password
		}
		if (decrypted) {
			const compressed = isCompressed(decrypted, compression);
			let plaintext: Uint8Array | undefined = decrypted;
			if (compressed) {
				try {
					plaintext = await inflateBackup(decrypted, version);
				} catch (err) {
					if (!(err instanceof BackupError)) throw err;
					failure ??= err;
					continue;
				}
			}
			// No plaintext: not a zlib header, which means a wrong password, like
			// invalid padding (FORMAT.md §2.1).
			if (plaintext) {
				const strict = parseStrict(plaintext);
				const records = strict?.notes ?? parseLenient(plaintext);
				if (strict || records.length > 0) {
					const { notes, excluded } = await normaliseRecords(records);
					return {
						formatVersion,
						createdAt,
						headerNoteCount,
						notes,
						sections: strict?.sections ?? [],
						recovered: !strict,
						excluded,
						passwordEncoding: candidate.encoding,
					};
				}
				if (compressed) {
					// The zlib checksum matched, so the password is right; the
					// contents are just not in the §3 layout.
					failure ??= new BackupError(
						"damaged",
						`The password is correct, but the contents of this backup (format ${version}) could not be read. ` +
							"The file may be damaged, or it may come from a ColorNote version that this importer does not support yet.",
					);
					continue;
				}
			}
		}
		if (await startsLikeBackup(key, ciphertext, compression)) failure ??= new BackupError("damaged", DAMAGED_MESSAGE);
	}

	if (failure) throw failure;
	throw new BackupError("wrong-password", "Wrong master password. Check it and try again.");
}

/**
 * Inflates the decrypted data of a compressed backup (FORMAT.md §2.1).
 * @returns undefined if the data does not start with a valid zlib header,
 *   which, like invalid padding, means a wrong password
 * @throws BackupError `damaged` if the stream does not inflate completely or
 *   its checksum does not match; `unsupported-platform` if this platform
 *   cannot inflate
 */
async function inflateBackup(decrypted: Uint8Array<ArrayBuffer>, version: string): Promise<Uint8Array | undefined> {
	if (!isZlibHeader(decrypted)) return undefined;
	const inflated = await inflateZlib(decrypted);
	if (!inflated) {
		throw new BackupError(
			"unsupported-platform",
			`This backup (format ${version}) is compressed, and Obsidian on this device cannot decompress it. ` +
				"Import it in Obsidian on a computer, or update this device (iOS 16.4 or later, " +
				"or a current Android System WebView) and try again.",
		);
	}
	if (!inflated.complete) throw new BackupError("damaged", DAMAGED_MESSAGE);
	return inflated.output;
}

/**
 * Whether bytes look like the start of the §3 layout: a small section kind
 * and count, then a record length and "{". Random bytes pass with a chance of
 * about 2^-32.
 */
function looksLikeSectionStart(bytes: Uint8Array): boolean {
	if (bytes.length < 16) return false;
	const kind = u32(bytes, 0);
	const count = u32(bytes, 4);
	return kind < 0x10000 && count < 0x1000000 && (bytes[12] === 0x7b || count === 0);
}

/**
 * For a file whose padding or parse failed: whether the start of the
 * ciphertext decrypts to the start of a backup anyway, which means that the
 * password is right and the file is damaged.
 */
async function startsLikeBackup(key: CryptoKey, ciphertext: Uint8Array, compression: Compression): Promise<boolean> {
	if (compression !== "zlib" && (await startsLikePlaintext(key, ciphertext))) return true;
	return compression !== "none" && (await startsLikeCompressedPlaintext(key, ciphertext));
}

/** Whether the first ciphertext block decrypts to a plausible section start. */
async function startsLikePlaintext(key: CryptoKey, ciphertext: Uint8Array): Promise<boolean> {
	try {
		return looksLikeSectionStart(await aesCbcDecryptFirstBlock(key, ciphertext));
	} catch {
		return false;
	}
}

/**
 * Whether the start of the ciphertext decrypts to a zlib stream that inflates
 * to a plausible section start (FORMAT.md §2.1). Only a prefix is decrypted,
 * without a padding check, so the stream is cut off; the output before the
 * cut is what counts. The last block is left out: its padding failed, so it
 * may be the damaged part.
 */
async function startsLikeCompressedPlaintext(key: CryptoKey, ciphertext: Uint8Array): Promise<boolean> {
	const length = Math.min(ZLIB_PROBE_BYTES, ciphertext.length - 16);
	if (length < 16) return false;
	try {
		const prefix = await aesCbcDecryptRaw(key, ciphertext.subarray(0, length));
		if (!isZlibHeader(prefix)) return false;
		const inflated = await inflateZlib(prefix);
		return inflated !== undefined && looksLikeSectionStart(inflated.output);
	} catch {
		return false;
	}
}

type RawRecord = Record<string, unknown>;

function parseJsonObject(bytes: Uint8Array): RawRecord | undefined {
	try {
		const value: unknown = JSON.parse(utf8Lenient.decode(bytes));
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as RawRecord;
	} catch {
		// not JSON
	}
	return undefined;
}

/**
 * The strict parse (FORMAT.md §3): sections must run exactly to the end.
 * Returns only the records of note sections; other sections (the account
 * record in particular) are stepped over without being decoded.
 */
function parseStrict(plaintext: Uint8Array): { notes: RawRecord[]; sections: SectionInfo[] } | undefined {
	if (plaintext.length === 0) return undefined;
	const notes: RawRecord[] = [];
	const sections: SectionInfo[] = [];
	let p = 0;
	while (p < plaintext.length) {
		if (plaintext.length - p < 8) return undefined;
		const kind = u32(plaintext, p);
		const count = u32(plaintext, p + 4);
		p += 8;
		for (let i = 0; i < count; i++) {
			if (plaintext.length - p < 4) return undefined;
			const length = u32(plaintext, p);
			p += 4;
			if (length < 2 || length > plaintext.length - p || plaintext[p] !== 0x7b) return undefined;
			if (kind === NOTES_SECTION) {
				const record = parseJsonObject(plaintext.subarray(p, p + length));
				if (!record) return undefined;
				notes.push(record);
			}
			p += length;
		}
		sections.push({ kind, records: count });
	}
	return { notes, sections };
}

/**
 * The lenient fallback (FORMAT.md §3): scan for length-prefixed JSON objects
 * and keep those that look like note records.
 */
function parseLenient(plaintext: Uint8Array): RawRecord[] {
	const notes: RawRecord[] = [];
	let p = 0;
	while (plaintext.length - p >= 4) {
		const length = u32(plaintext, p);
		if (length >= 2 && length <= plaintext.length - p - 4 && plaintext[p + 4] === 0x7b) {
			const record = parseJsonObject(plaintext.subarray(p + 4, p + 4 + length));
			if (record) {
				if (toNumber(record.type) !== undefined && typeof record.note === "string") notes.push(record);
				p += 4 + length;
				continue;
			}
		}
		p += 1;
	}
	return notes;
}

/** A number from a JSON value read defensively: numbers, numeric strings, booleans. */
function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value.trim());
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function toInt(value: unknown, fallback: number): number {
	const n = toNumber(value);
	return n === undefined ? fallback : Math.trunc(n);
}

function toText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function isTruthy(value: unknown): boolean {
	const n = toNumber(value);
	if (n !== undefined) return n !== 0;
	if (typeof value === "string") return value.trim() !== "" && value.trim().toLowerCase() !== "false";
	return false;
}

type Disposition = "active" | "trash" | "internal" | "deleted" | "other";

function classify(record: RawRecord): Disposition {
	if (!("note" in record) || !("type" in record)) return "internal";
	const type = toNumber(record.type);
	const state = toInt(record.active_state, STATE_ACTIVE);
	if (type === TYPE_INTERNAL || state === STATE_INTERNAL) return "internal";
	if (INTERNAL_TITLES.has(toText(record.title).trim())) return "internal";
	if (type === undefined) return "other";
	if (state === STATE_DELETED) return "deleted";
	if (state === STATE_ACTIVE) return "active";
	if (state === STATE_TRASH) return "trash";
	return "other";
}

async function normaliseRecords(
	records: RawRecord[],
): Promise<{ notes: BackupNote[]; excluded: DecodedBackup["excluded"] }> {
	const notes: BackupNote[] = [];
	const excluded = { internal: 0, deleted: 0, other: 0 };
	for (const record of records) {
		const disposition = classify(record);
		if (disposition !== "active" && disposition !== "trash") {
			excluded[disposition]++;
			continue;
		}
		const locked = isTruthy(record.encrypted);
		let body = toText(record.note);
		let lockedDecryptFailed = false;
		if (locked) {
			const plain = await decryptLockedBody(body);
			lockedDecryptFailed = plain === undefined;
			body = plain ?? "";
		}
		const status = toInt(record.status, 0);
		notes.push({
			id: toInt(record._id, 0),
			uuid: toText(record.uuid).trim(),
			title: toText(record.title),
			body,
			isChecklist: toNumber(record.type) === TYPE_CHECKLIST,
			inTrash: disposition === "trash",
			colorIndex: toInt(record.color_index, 3),
			locked,
			lockedDecryptFailed,
			checked: Math.floor(Math.abs(status) / 16) % 2 === 1,
			created: Math.max(0, toInt(record.created_date, 0)),
			modified: Math.max(0, toInt(record.modified_date, 0)),
			reminder: readReminder(record),
		});
	}
	return { notes, excluded };
}

/**
 * A note record's pending reminder (FORMAT.md §7). There is none when
 * `reminder_date` is 0, whatever the other fields say. A positive date is an
 * all-day reminder for type 16 and a time alarm for any other type.
 */
function readReminder(record: RawRecord): Reminder | null {
	const date = toInt(record.reminder_date, 0);
	if (date === 0) return null;
	const type = toInt(record.reminder_type, 0);
	if (date < 0) {
		// -1 marks a status-bar pin. Other negative dates have not been seen;
		// with the status-bar type they are a pin too, otherwise they have no
		// meaning.
		return date === STATUS_BAR_DATE || type === REMINDER_STATUS_BAR ? { kind: "status-bar" } : null;
	}
	const repeat = REMINDER_REPEATS.get(toInt(record.reminder_repeat, 0)) ?? null;
	return {
		kind: type === REMINDER_ALL_DAY ? "all-day" : "time",
		date,
		repeat,
		repeatEnds: repeat === null ? 0 : Math.max(0, toInt(record.reminder_repeat_ends, 0)),
	};
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Map<string, number>(Array.from(BASE64, (c, i) => [c, i]));

/** Standard base64 (URL-safe characters also accepted); undefined if invalid. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
	const clean = text.replace(/\s+/g, "").replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
	if (clean.length % 4 === 1) return undefined;
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let bits = 0;
	let value = 0;
	let o = 0;
	for (const c of clean) {
		const v = BASE64_VALUES.get(c);
		if (v === undefined) return undefined;
		value = (value << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[o++] = (value >>> bits) & 0xff;
		}
	}
	return out;
}

/** Decrypts a locked note's body (FORMAT.md §5); undefined on failure. */
async function decryptLockedBody(note: string): Promise<string | undefined> {
	if (note.trim() === "") return "";
	const ciphertext = decodeBase64(note);
	if (!ciphertext || ciphertext.length === 0 || ciphertext.length % 16 !== 0) return undefined;
	try {
		lockedCryptoKey ??= lockedNoteKey().then(importAesKey);
		return utf8Strict.decode(await aesCbcDecrypt(await lockedCryptoKey, ciphertext));
	} catch {
		return undefined;
	}
}
