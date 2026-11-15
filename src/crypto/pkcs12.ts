// PKCS#12 key derivation (RFC 7292, Appendix B.2) with SHA-256, on WebCrypto.

const U = 32; // SHA-256 output size in bytes
const V = 64; // SHA-256 block size in bytes

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** `src` repeated to fill `ceil(src.length / V) * V` bytes (empty stays empty). */
function stretch(src: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(Math.ceil(src.length / V) * V);
	for (let i = 0; i < out.length; i++) out[i] = src[i % src.length];
	return out;
}

/**
 * RFC 7292 B.2 with SHA-256 (u = 32, v = 64).
 * @param id 1 for key material, 2 for an IV, 3 for a MAC key
 * @param password the password already formatted by the caller (for example a
 *   BMPString with its two trailing zero bytes)
 */
export async function pkcs12Kdf(
	id: number,
	password: Uint8Array,
	salt: Uint8Array,
	iterations: number,
	length: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const d = new Uint8Array(V).fill(id);
	const s = stretch(salt);
	const p = stretch(password);
	const i = new Uint8Array(s.length + p.length);
	i.set(s);
	i.set(p, s.length);

	const blocks = Math.ceil(length / U);
	const out = new Uint8Array(blocks * U);
	for (let n = 0; n < blocks; n++) {
		const di = new Uint8Array(V + i.length);
		di.set(d);
		di.set(i, V);
		let a = await sha256(di);
		for (let r = 1; r < iterations; r++) a = await sha256(a);
		out.set(a, n * U);
		if (n === blocks - 1) break;

		// I_j = (I_j + B + 1) mod 2^(8v) for every v-byte block I_j of I,
		// where B is A repeated to v bytes.
		const b = new Uint8Array(V);
		for (let k = 0; k < V; k++) b[k] = a[k % U];
		for (let j = 0; j < i.length; j += V) {
			let carry = 1;
			for (let k = V - 1; k >= 0; k--) {
				const sum = i[j + k] + b[k] + carry;
				i[j + k] = sum & 0xff;
				carry = sum >>> 8;
			}
		}
	}
	return out.slice(0, length);
}

/** A string as a PKCS#12 BMPString: UTF-16BE followed by two zero bytes. */
export function bmpString(text: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(text.length * 2 + 2);
	for (let k = 0; k < text.length; k++) {
		const unit = text.charCodeAt(k);
		out[k * 2] = unit >>> 8;
		out[k * 2 + 1] = unit & 0xff;
	}
	return out;
}
