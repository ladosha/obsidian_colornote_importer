// zlib streams (RFC 1950), for format 9 backups (docs/FORMAT.md §2.1).
// Inflating uses the platform's Compression Streams API: "deflate" is the
// zlib format. The header check and the Adler-32 checksum are done here, so
// that a stream counts as complete only when its checksum matches the data
// that came out, whichever implementation inflated it.

/**
 * Whether `bytes` start with a zlib header that a decompressor without a
 * preset dictionary accepts (RFC 1950 §2.2): compression method 8 (DEFLATE),
 * a window of at most 32 KB (CINFO <= 7), the two bytes as a big-endian u16 a
 * multiple of 31, and no preset dictionary (FDICT, which the Compression
 * Streams API rejects). FORMAT.md §2.1 names the first and third rules; the
 * other two only reject headers that no decompressor here could read anyway.
 */
export function isZlibHeader(bytes: Uint8Array): boolean {
	if (bytes.length < 2) return false;
	const cmf = bytes[0];
	const flg = bytes[1];
	return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0 && (flg & 0x20) === 0;
}

const ADLER_BASE = 65521;
/** Bytes that can be summed before the sums must be reduced (zlib's NMAX). */
const ADLER_BLOCK = 5552;

/** The Adler-32 checksum of `bytes` (RFC 1950 §8.2), as an unsigned number. */
export function adler32(bytes: Uint8Array): number {
	let s1 = 1;
	let s2 = 0;
	for (let start = 0; start < bytes.length; start += ADLER_BLOCK) {
		const end = Math.min(start + ADLER_BLOCK, bytes.length);
		for (let i = start; i < end; i++) {
			s1 += bytes[i];
			s2 += s1;
		}
		s1 %= ADLER_BASE;
		s2 %= ADLER_BASE;
	}
	return s2 * 0x10000 + s1;
}

/** Compressed bytes written to the decompressor at a time. */
const WRITE_CHUNK = 1024;

export interface InflateResult {
	/**
	 * The inflated data. For a stream that is cut off or invalid, the part that
	 * came out before the error (possibly empty).
	 */
	output: Uint8Array<ArrayBuffer>;
	/**
	 * True when `data` is exactly one zlib stream that inflated to the end and
	 * whose Adler-32 checksum (its last 4 bytes) matches `output`.
	 */
	complete: boolean;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	let o = 0;
	for (const chunk of chunks) {
		out.set(chunk, o);
		o += chunk.length;
	}
	return out;
}

/**
 * Inflates `data`, which should be one zlib stream with nothing after it.
 * Never rejects: a damaged stream gives `complete: false`.
 * @returns undefined when the platform has no Compression Streams API: iOS
 *   before 16.4, Android System WebView before 80 (Obsidian runs on both)
 */
export async function inflateZlib(data: Uint8Array<ArrayBuffer>): Promise<InflateResult | undefined> {
	if (typeof DecompressionStream !== "function") return undefined;
	let stream: DecompressionStream;
	try {
		stream = new DecompressionStream("deflate");
	} catch {
		return undefined; // the API exists but does not know the format
	}
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reading = (async (): Promise<void> => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			chunks.push(value);
			length += value.length;
		}
	})();
	const writing = (async (): Promise<void> => {
		// In chunks: a transform stream takes its next chunk only after the
		// reader has taken all output so far, and an error discards output
		// that was not taken yet. So when the stream turns out to be damaged
		// or cut off, the output of all earlier chunks is kept (the
		// damaged-file probe in backup.ts needs the start of it).
		for (let p = 0; p < data.length; p += WRITE_CHUNK) await writer.write(data.subarray(p, p + WRITE_CHUNK));
		await writer.close();
	})();
	const [read, written] = await Promise.allSettled([reading, writing]);
	const output = concat(chunks, length);
	const inflated = read.status === "fulfilled" && written.status === "fulfilled";
	const n = data.length;
	const trailer = n >= 6 ? ((data[n - 4] << 24) | (data[n - 3] << 16) | (data[n - 2] << 8) | data[n - 1]) >>> 0 : -1;
	return { output, complete: inflated && trailer === adler32(output) };
}
