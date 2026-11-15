// Shared test helpers: fixture loading and building synthetic backups.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, type ZlibOptions } from "node:zlib";
import { BackupError, type BackupErrorCode, backupKey, type BackupNote, decodeBackup } from "../src/backup";

const FIXTURES = join(process.cwd(), "test", "fixtures");

export interface ExpectedRecord {
	_id: number;
	title: string;
	note: string;
	encrypted: number;
	active_state: number;
	type: number;
	status: number;
	color_index: number;
	created_date: number;
	modified_date: number;
	reminder_date: number;
	reminder_type: number;
	reminder_repeat: number;
	reminder_repeat_ends: number;
	uuid: string;
}

export interface ExpectedFixture {
	password: string;
	formatVersion: [number, number];
	createdAt: number;
	headerNoteCount: number;
	accountRecordCount?: number;
	unknownSectionKinds?: number[];
	records: ExpectedRecord[];
}

/** A fixture that must fail to decode. */
export interface ExpectedErrorFixture {
	password: string;
	formatVersion: [number, number];
	expectError: BackupErrorCode;
}

export interface Expected {
	"sample.backup": ExpectedFixture;
	"sample-v9.backup": ExpectedFixture;
	"truncated-v9.backup": ExpectedErrorFixture;
	"no-password.backup": ExpectedFixture;
	"latin1-password.backup": ExpectedFixture;
	secretsThatMustNeverAppearInOutput: string[];
	keyTestVectors: Record<string, string>;
}

export const FIXTURE_NAMES = [
	"sample.backup",
	"sample-v9.backup",
	"no-password.backup",
	"latin1-password.backup",
] as const;

export function loadExpected(): Expected {
	return JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as Expected;
}

export function loadFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** Asserts that `promise` rejects with a BackupError with this code and a message. */
export async function assertRejects(promise: Promise<unknown>, code: BackupErrorCode): Promise<BackupError> {
	let error: BackupError | undefined;
	await assert.rejects(promise, (err: unknown) => {
		assert.ok(err instanceof BackupError, `expected a BackupError, got ${String(err)}`);
		assert.equal(err.code, code);
		assert.ok(err.message.length > 0);
		error = err;
		return true;
	});
	assert.ok(error);
	return error;
}

/**
 * Runs `fn` as if the platform had no Compression Streams API, like iOS
 * before 16.4.
 */
export async function withoutDecompressionStream<T>(fn: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream");
	assert.ok(descriptor?.configurable, "DecompressionStream can be removed for the test");
	Object.defineProperty(globalThis, "DecompressionStream", { value: undefined, configurable: true, writable: true });
	try {
		return await fn();
	} finally {
		Object.defineProperty(globalThis, "DecompressionStream", descriptor);
	}
}

export function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function ascii(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** A note with defaults, for render and plan tests. */
export function makeNote(overrides: Partial<BackupNote>): BackupNote {
	return {
		id: 1,
		uuid: "",
		title: "",
		body: "",
		isChecklist: false,
		inTrash: false,
		colorIndex: 3,
		locked: false,
		lockedDecryptFailed: false,
		checked: false,
		created: 0,
		modified: 0,
		reminder: null,
		...overrides,
	};
}

/**
 * Runs `fn` with the local time zone set to `zone` (an IANA name), then
 * restores the previous one. `fn` must be synchronous, so that no other test
 * runs in the other zone.
 */
export function withTimeZone<T>(zone: string, fn: () => T): T {
	const saved = process.env.TZ;
	process.env.TZ = zone;
	try {
		return fn();
	} finally {
		if (saved === undefined) delete process.env.TZ;
		else process.env.TZ = saved;
	}
}

function u32(n: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, n);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** Plaintext sections as FORMAT.md §3 describes them. */
export function buildPlaintext(sections: { kind: number; records: object[] }[]): Uint8Array<ArrayBuffer> {
	const parts: Uint8Array[] = [];
	for (const section of sections) {
		parts.push(u32(section.kind), u32(section.records.length));
		for (const record of section.records) {
			const json = new TextEncoder().encode(JSON.stringify(record));
			parts.push(u32(json.length), json);
		}
	}
	return concat(parts);
}

/** A zlib stream (RFC 1950) of `data`, as format 9 backups hold it (FORMAT.md §2.1). */
export function zlib(data: Uint8Array, options?: ZlibOptions): Uint8Array<ArrayBuffer> {
	return new Uint8Array(deflateSync(data, options));
}

/**
 * A complete backup file (header + AES-128-CBC ciphertext) for `plaintext`,
 * encrypted as given: compress it first (`zlib`) for format 9.
 */
export async function buildBackup(
	plaintext: Uint8Array<ArrayBuffer>,
	passwordBytes: Uint8Array,
	version: [number, number] = [8, 1],
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", backupKey(passwordBytes), { name: "AES-CBC" }, false, ["encrypt"]);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, key, plaintext),
	);
	const header = new Uint8Array(28);
	header.set([0, 0x4e, 0, 0x4f, 0, 0x54, 0, 0x45]);
	const view = new DataView(header.buffer);
	view.setUint32(8, version[0]);
	view.setUint32(12, version[1]);
	view.setUint32(16, 0x174);
	view.setUint32(20, 0x5a1b2c3d);
	view.setUint32(24, 1);
	return concat([header, ciphertext]);
}

/** The exported notes of a synthetic backup (no master password) that holds these note records. */
export async function decodeRecords(records: Record<string, unknown>[]): Promise<BackupNote[]> {
	const plaintext = buildPlaintext([{ kind: 2, records }]);
	return (await decodeBackup(await buildBackup(plaintext, ascii("0000")), "")).notes;
}

/** A minimal plain note record. */
export function noteRecord(fields: Record<string, unknown>): Record<string, unknown> {
	return {
		_id: 1,
		title: "Note",
		note: "body",
		encrypted: 0,
		active_state: 0,
		type: 0,
		status: 0,
		color_index: 3,
		created_date: 1600000000000,
		modified_date: 1600000000000,
		reminder_date: 0,
		uuid: "00000000-0000-4000-8000-0000000000aa",
		...fields,
	};
}
