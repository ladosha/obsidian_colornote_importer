import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { backupKey, decodeBase64, lockedNoteKey, passwordLowBytes } from "../src/backup";
import { aesCbcDecryptFirstBlock, aesCbcDecryptRaw, importAesKey } from "../src/crypto/aes";
import { md5 } from "../src/crypto/md5";
import { bmpString, pkcs12Kdf } from "../src/crypto/pkcs12";
import { ascii, hex, loadExpected } from "./helpers";

test("MD5 matches the RFC 1321 test suite", () => {
	const vectors: [string, string][] = [
		["", "d41d8cd98f00b204e9800998ecf8427e"],
		["a", "0cc175b9c0f1b6a831c399e269772661"],
		["abc", "900150983cd24fb0d6963f7d28e17f72"],
		["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
		["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
		["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
		["1234567890".repeat(8), "57edf4a22be3c955ac49da2e2107b67a"],
	];
	for (const [input, digest] of vectors) assert.equal(hex(md5(ascii(input))), digest, JSON.stringify(input));
});

test("MD5 agrees with node:crypto across block boundaries", () => {
	for (let length = 0; length <= 200; length++) {
		const data = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
		assert.equal(hex(md5(data)), createHash("md5").update(data).digest("hex"), `length ${length}`);
	}
});

test("backup key test vectors", () => {
	const vectors = loadExpected().keyTestVectors;
	assert.equal(hex(backupKey(passwordLowBytes("0000"))), "298b599af054ad5d0c7d80680419378b");
	assert.equal(hex(backupKey(passwordLowBytes("0000"))), vectors["backupKey(0000)"]);
	assert.equal(hex(backupKey(passwordLowBytes("correct horse 7"))), vectors["backupKey(correct horse 7)"]);
});

test("locked note key test vector (PKCS#12 KDF, SHA-256)", async () => {
	const expected = "703b84c1fdc301cc5eb97fa793b8c03e5f3b0ae4207d40f6ad7d21e511938b35";
	assert.equal(hex(await lockedNoteKey()), expected);
	assert.equal(hex(await lockedNoteKey()), loadExpected().keyTestVectors.lockedNoteKey);
});

test("PKCS#12 KDF output longer than one hash block starts with the one-block output", async () => {
	const password = bmpString("ColorNote Password");
	const salt = ascii("ColorNote Fixed Salt");
	const short = await pkcs12Kdf(1, password, salt, 20, 32);
	const long = await pkcs12Kdf(1, password, salt, 20, 80);
	assert.equal(long.length, 80);
	assert.deepEqual(long.slice(0, 32), short);
	assert.notDeepEqual(long.slice(32, 64), short);
});

test("AES-CBC decryption without a padding check", async () => {
	const key = await importAesKey(backupKey(passwordLowBytes("0000")));
	const plaintext = Uint8Array.from({ length: 48 }, (_, i) => i * 5);
	// PKCS#7 adds a whole block of 0x10 to a plaintext of whole blocks.
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, key, plaintext),
	);
	assert.equal(ciphertext.length, 64);
	assert.deepEqual(await aesCbcDecryptRaw(key, ciphertext.subarray(0, 48)), plaintext);
	assert.deepEqual(await aesCbcDecryptRaw(key, ciphertext.subarray(0, 32)), plaintext.subarray(0, 32));
	assert.deepEqual(await aesCbcDecryptRaw(key, ciphertext), Uint8Array.from([...plaintext, ...new Uint8Array(16).fill(16)]));
	assert.deepEqual(await aesCbcDecryptFirstBlock(key, ciphertext), plaintext.subarray(0, 16));
	await assert.rejects(aesCbcDecryptRaw(key, ciphertext.subarray(0, 20)), RangeError);
	await assert.rejects(aesCbcDecryptRaw(key, new Uint8Array(0)), RangeError);
});

test("BMPString encoding", () => {
	assert.equal(hex(bmpString("Aé")), "004100e90000");
});

test("password low-byte encoding", () => {
	// p ä s s w ö r d -> 70 e4 73 73 77 f6 72 64
	assert.equal(hex(passwordLowBytes("pässwörd")), "70e4737377f67264");
	assert.equal(hex(passwordLowBytes("Ł")), "41"); // Ł = U+0141 -> 0x41
});

test("base64 decoding", () => {
	assert.equal(hex(decodeBase64("") ?? new Uint8Array([1])), "");
	assert.equal(hex(decodeBase64("Zm9vYmFy") ?? new Uint8Array()), hex(ascii("foobar")));
	assert.equal(hex(decodeBase64("Zm9vYg==") ?? new Uint8Array()), hex(ascii("foob")));
	assert.equal(hex(decodeBase64("Zm9v\nYmE=") ?? new Uint8Array()), hex(ascii("fooba")));
	assert.equal(hex(decodeBase64("+/8=") ?? new Uint8Array()), "fbff");
	assert.equal(decodeBase64("Zm9v!"), undefined);
	assert.equal(decodeBase64("Z"), undefined);
});
