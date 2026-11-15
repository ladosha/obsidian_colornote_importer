import assert from "node:assert/strict";
import { test } from "node:test";
import { constants } from "node:zlib";
import { adler32, inflateZlib, isZlibHeader } from "../src/zlib";
import { ascii, withoutDecompressionStream, zlib } from "./helpers";

/** Deterministic, poorly compressible bytes. */
function noise(length: number, seed = 1): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	let x = seed;
	for (let i = 0; i < length; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

/** Text-like bytes that compress about as well as a backup's JSON records. */
function records(count: number): Uint8Array<ArrayBuffer> {
	const parts = Array.from({ length: count }, (_, i) => `{"_id":${i},"title":"Note ${i}","note":"line ${(i * 7919) % 1000}"}`);
	return ascii(parts.join("")) as Uint8Array<ArrayBuffer>;
}

function u32(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset);
}

test("zlib header check (RFC 1950 §2.2, FORMAT.md §2.1)", () => {
	for (const header of [[0x78, 0x01], [0x78, 0x5e], [0x78, 0x9c], [0x78, 0xda], [0x08, 0x1d], [0x68, 0x81]]) {
		assert.equal(isZlibHeader(Uint8Array.from(header)), true, header.join(" "));
	}
	const invalid = [
		[], // too short
		[0x78],
		[0x00, 0x00], // a multiple of 31, but §3 data: CM 0
		[0x78, 0x9d], // not a multiple of 31
		[0x79, 0x18], // CM 9
		[0x88, 0x1c], // CINFO 8
		[0x78, 0xbb], // FDICT
	];
	for (const header of invalid) assert.equal(isZlibHeader(Uint8Array.from(header)), false, header.join(" "));
	// Whatever zlib writes is accepted.
	for (let level = 0; level <= 9; level++) {
		for (const windowBits of [9, 12, 15]) assert.ok(isZlibHeader(zlib(ascii("x"), { level, windowBits })));
	}
});

test("Adler-32", () => {
	assert.equal(adler32(new Uint8Array(0)), 1);
	assert.equal(adler32(ascii("a")), 0x00620062);
	assert.equal(adler32(ascii("abc")), 0x024d0127);
	assert.equal(adler32(ascii("Wikipedia")), 0x11e60398);
	// The checksum zlib writes at the end of a stream, including inputs long
	// enough that the sums must be reduced many times.
	const inputs = [noise(1), noise(5552), noise(5553), noise(100_000), new Uint8Array(100_000).fill(0xff)];
	for (const input of inputs) {
		const stream = zlib(input);
		assert.equal(adler32(input), u32(stream, stream.length - 4), `length ${input.length}`);
	}
});

test("inflates complete zlib streams of every block type", async () => {
	const inputs = [new Uint8Array(0), ascii("a"), records(2000), noise(300_000)];
	const variants = [
		{},
		{ level: 0 },
		{ level: 9 },
		{ strategy: constants.Z_FIXED },
		{ strategy: constants.Z_HUFFMAN_ONLY },
		{ strategy: constants.Z_RLE },
	];
	for (const input of inputs) {
		for (const options of variants) {
			const result = await inflateZlib(zlib(input, options));
			const what = `${input.length} bytes, ${JSON.stringify(options)}`;
			assert.ok(result, what);
			assert.equal(result.complete, true, what);
			assert.deepEqual(result.output, input, what);
		}
	}
});

test("a stream that is cut off is incomplete, and keeps the output so far", async () => {
	const input = records(3000);
	const stream = zlib(input);
	for (const length of [2, 3, 100, 600, Math.floor(stream.length / 2), stream.length - 5, stream.length - 1]) {
		const result = await inflateZlib(stream.slice(0, length));
		assert.ok(result);
		assert.equal(result.complete, false, `cut at ${length}`);
		assert.deepEqual(result.output, input.subarray(0, result.output.length), `cut at ${length}`);
		// The damaged-file probe relies on the start of the output.
		if (length >= 600) assert.ok(result.output.length >= 16, `output for a cut at ${length}`);
	}
});

test("a wrong checksum, damaged data or data after the stream is incomplete", async () => {
	const input = records(500);
	const stream = zlib(input);
	const checksum = stream.slice();
	checksum[checksum.length - 1] ^= 1;
	const middle = stream.slice();
	for (let i = 100; i < 120; i++) middle[i] ^= 0x5a;
	const trailing = new Uint8Array(stream.length + 1);
	trailing.set(stream);
	const twice = new Uint8Array(stream.length * 2);
	twice.set(stream);
	twice.set(stream, stream.length);
	for (const [what, data] of Object.entries({ checksum, middle, trailing, twice })) {
		const result = await inflateZlib(data);
		assert.ok(result);
		assert.equal(result.complete, false, what);
	}
	const garbage = await inflateZlib(Uint8Array.from([0x78, 0x9c, ...noise(64)]));
	assert.equal(garbage?.complete, false);
	assert.equal((await inflateZlib(new Uint8Array(0)))?.complete, false);
});

test("without the Compression Streams API there is no result", async () => {
	await withoutDecompressionStream(async () => {
		assert.equal(await inflateZlib(zlib(ascii("x"))), undefined);
	});
});
