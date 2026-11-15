// Format 9 backups: zlib-compressed plaintext (FORMAT.md §2.1), and telling
// compressed from uncompressed data for other versions.

import assert from "node:assert/strict";
import { test } from "node:test";
import { constants } from "node:zlib";
import { decodeBackup } from "../src/backup";
import {
	ascii,
	assertRejects,
	buildBackup,
	buildPlaintext,
	loadExpected,
	loadFixture,
	noteRecord,
	withoutDecompressionStream,
	zlib,
} from "./helpers";

const expected = loadExpected();
const PASSWORD = expected["sample-v9.backup"].password;

/** A small backup plaintext: an account record and two notes (FORMAT.md §3). */
function plaintext(): Uint8Array<ArrayBuffer> {
	return buildPlaintext([
		{ kind: 1, records: [{ auth_token: "FAKE-AUTH-TOKEN-DO-NOT-EXPORT" }] },
		{ kind: 2, records: [noteRecord({ _id: 7, title: "First" }), noteRecord({ _id: 8, title: "Second" })] },
	]);
}

function titles(decoded: { notes: { title: string }[] }): string[] {
	return decoded.notes.map((n) => n.title);
}

/** Flips the bits of one byte; a negative index counts from the end. */
function flip(data: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
	const out = data.slice();
	out[index < 0 ? out.length + index : index] ^= 0xff;
	return out;
}

test("sample-v9.backup decodes to exactly what sample.backup does", async () => {
	const v8 = await decodeBackup(loadFixture("sample.backup"), expected["sample.backup"].password);
	const v9 = await decodeBackup(loadFixture("sample-v9.backup"), PASSWORD);
	assert.deepEqual(v8.formatVersion, [8, 1]);
	assert.deepEqual(v9.formatVersion, [9, 1]);
	assert.deepEqual({ ...v9, formatVersion: v8.formatVersion }, v8);
	assert.equal(v9.passwordEncoding, "low-byte");
	assert.equal(v9.recovered, false);
});

test("truncated-v9.backup: right password, cut-off zlib stream, is damaged", async () => {
	const fixture = expected["truncated-v9.backup"];
	const data = loadFixture("truncated-v9.backup");
	const error = await assertRejects(decodeBackup(data, fixture.password), fixture.expectError);
	assert.equal(fixture.expectError, "damaged");
	assert.match(error.message, /password is correct/);
	await assertRejects(decodeBackup(data, "wrong horse 7"), "wrong-password");
	await assertRejects(decodeBackup(data, ""), "wrong-password");
});

test("format 9: wrong password", async () => {
	const data = loadFixture("sample-v9.backup");
	await assertRejects(decodeBackup(data, "wrong horse 7"), "wrong-password");
	await assertRejects(decodeBackup(data, ""), "wrong-password");
	await assertRejects(decodeBackup(data, "correct horse 8"), "wrong-password");
});

test("format 9: invalid padding with the right password is damaged", async () => {
	const data = loadFixture("sample-v9.backup");
	// Cut on a block boundary: the padding check fails, but the start of the
	// data still inflates to the start of a backup.
	for (const cut of [16, 32, 64, data.length - 28 - 160]) {
		await assertRejects(decodeBackup(data.slice(0, data.length - cut), PASSWORD), "damaged");
		await assertRejects(decodeBackup(data.slice(0, data.length - cut), "nope"), "wrong-password");
	}
	// The last block damaged.
	await assertRejects(decodeBackup(flip(data, -3), PASSWORD), "damaged");
	await assertRejects(decodeBackup(flip(data, -3), "nope"), "wrong-password");
});

test("format 9: a zlib stream that does not inflate completely is damaged", async () => {
	const stream = zlib(plaintext());
	const trailing = new Uint8Array(stream.length + 3);
	trailing.set(stream);
	trailing.set([1, 2, 3], stream.length);
	const broken = {
		"cut off": stream.slice(0, Math.floor(stream.length / 2)),
		"without its checksum": stream.slice(0, stream.length - 4),
		"wrong checksum": flip(stream, -1),
		"damaged in the middle": flip(stream, Math.floor(stream.length / 2)),
		"data after the stream": trailing,
	};
	for (const [what, data] of Object.entries(broken)) {
		const error = await assertRejects(decodeBackup(await buildBackup(data, ascii("0000"), [9, 1]), ""), "damaged");
		assert.match(error.message, /password is correct/, what);
	}
});

test("format 9: data without a valid zlib header means a wrong password", async () => {
	const stream = zlib(plaintext());
	// Each of these headers is a multiple of 31 except the second.
	const notZlib = {
		"uncompressed data": plaintext(),
		"header not a multiple of 31": flip(stream, 1),
		"method other than DEFLATE (CM 9)": Uint8Array.from([0x79, 0x18, ...stream.subarray(2)]),
		"window over 32 KB (CINFO 8)": Uint8Array.from([0x88, 0x1c, ...stream.subarray(2)]),
		"preset dictionary (FDICT)": Uint8Array.from([0x78, 0xbb, 0, 0, 0, 1, ...stream.subarray(2)]),
		"random bytes": new Uint8Array(64).fill(0xab),
	};
	for (const [what, data] of Object.entries(notZlib)) {
		await assert.doesNotReject(async () => {
			await assertRejects(decodeBackup(await buildBackup(data, ascii("0000"), [9, 1]), ""), "wrong-password");
		}, what);
	}
});

test("format 9: a complete stream whose contents are not backup sections", async () => {
	const data = await buildBackup(zlib(ascii("Not the plaintext of a backup, but a valid zlib stream.")), ascii("0000"), [9, 1]);
	const error = await assertRejects(decodeBackup(data, ""), "damaged");
	assert.match(error.message, /format 9\.1/);
});

test("format 9: every kind of DEFLATE block decodes", async () => {
	const variants = [
		{ level: 0 }, // stored blocks
		{ level: 1 },
		{ level: 9 },
		{ strategy: constants.Z_FIXED }, // fixed Huffman codes
		{ strategy: constants.Z_HUFFMAN_ONLY },
		{ strategy: constants.Z_RLE },
		{ windowBits: 9 },
	];
	for (const options of variants) {
		const data = await buildBackup(zlib(plaintext(), options), ascii("0000"), [9, 1]);
		const decoded = await decodeBackup(data, "");
		assert.deepEqual(titles(decoded), ["First", "Second"], JSON.stringify(options));
		assert.deepEqual(decoded.sections, [{ kind: 1, records: 1 }, { kind: 2, records: 2 }]);
		assert.ok(!JSON.stringify(decoded).includes("FAKE-AUTH-TOKEN"));
	}
});

test("format 9: lenient fallback after inflating", async () => {
	const good = plaintext();
	// Break the note section's record count so the strict parse fails.
	const broken = good.slice();
	const view = new DataView(broken.buffer);
	const accountLength = view.getUint32(8); // kind@0, count@4, first record length@8
	view.setUint32(8 + 4 + accountLength + 4, 99);
	const decoded = await decodeBackup(await buildBackup(zlib(broken), ascii("0000"), [9, 1]), "");
	assert.equal(decoded.recovered, true);
	assert.deepEqual(decoded.sections, []);
	assert.deepEqual(titles(decoded), ["First", "Second"]);
	assert.ok(!JSON.stringify(decoded).includes("FAKE-AUTH-TOKEN"));
});

test("format 9: non-ASCII password falls back to UTF-8 bytes", async () => {
	const password = "пароль";
	const data = await buildBackup(zlib(plaintext()), new TextEncoder().encode(password), [9, 1]);
	const decoded = await decodeBackup(data, password);
	assert.equal(decoded.passwordEncoding, "utf-8");
	assert.deepEqual(titles(decoded), ["First", "Second"]);
	await assertRejects(decodeBackup(data, "парол"), "wrong-password");
});

test("format 8 means uncompressed, even when the data is a zlib stream", async () => {
	const data = await buildBackup(zlib(plaintext()), ascii("0000"), [8, 1]);
	await assertRejects(decodeBackup(data, ""), "wrong-password");
});

test("other versions: compression is told from the decrypted data", async () => {
	for (const version of [[10, 0], [7, 1], [9999, 3], [0, 0]] as [number, number][]) {
		const what = version.join(".");
		const compressed = await buildBackup(zlib(plaintext()), ascii("0000"), version);
		const uncompressed = await buildBackup(plaintext(), ascii("0000"), version);
		for (const data of [compressed, uncompressed]) {
			const decoded = await decodeBackup(data, "");
			assert.deepEqual(decoded.formatVersion, version);
			assert.deepEqual(titles(decoded), ["First", "Second"], what);
			assert.equal(decoded.recovered, false);
			await assertRejects(decodeBackup(data, "1234"), "wrong-password");
			// Cut on a block boundary: damaged, whichever the layout.
			await assertRejects(decodeBackup(data.slice(0, data.length - 16), ""), "damaged");
			await assertRejects(decodeBackup(data.slice(0, data.length - 16), "1234"), "wrong-password");
		}
		const cutStream = zlib(plaintext()).slice(0, 40);
		await assertRejects(decodeBackup(await buildBackup(cutStream, ascii("0000"), version), ""), "damaged");
	}
});

test("without the Compression Streams API: a clear error, not a crash", async () => {
	await withoutDecompressionStream(async () => {
		const error = await assertRejects(decodeBackup(loadFixture("sample-v9.backup"), PASSWORD), "unsupported-platform");
		assert.match(error.message, /format 9\.1/);
		// A wrong password is still found, from the zlib header.
		await assertRejects(decodeBackup(loadFixture("sample-v9.backup"), "nope"), "wrong-password");
		// Uncompressed backups do not need it.
		const decoded = await decodeBackup(loadFixture("sample.backup"), expected["sample.backup"].password);
		assert.equal(decoded.notes.length, 17);
		const detected = await decodeBackup(await buildBackup(plaintext(), ascii("0000"), [10, 0]), "");
		assert.deepEqual(titles(detected), ["First", "Second"]);
	});
	// And it is back afterwards.
	assert.equal((await decodeBackup(loadFixture("sample-v9.backup"), PASSWORD)).notes.length, 17);
});
