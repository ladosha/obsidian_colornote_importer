// AES-CBC with a zero IV and PKCS#7 padding, on WebCrypto.

const ZERO_IV = new Uint8Array(16);

export function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

/**
 * Decrypts `data` and removes the PKCS#7 padding. Rejects when the padding is
 * invalid, which for a password-derived key usually means a wrong password.
 */
export async function aesCbcDecrypt(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ZERO_IV }, key, data));
}

/**
 * Decrypts `data` (whole 16-byte blocks) without looking at padding, so the
 * result has the same length as `data`. WebCrypto always checks the padding,
 * so this appends a block that decrypts to a full padding block: in CBC,
 * P(n+1) = D(C(n+1)) XOR C(n), so C(n+1) = E(C(n) XOR 0x10...) gives
 * P(n+1) = 0x10 * 16. Used to tell a damaged file (whose start decrypts to
 * plausible data) from a wrong password.
 */
export async function aesCbcDecryptRaw(key: CryptoKey, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	if (data.length === 0 || data.length % 16 !== 0) throw new RangeError("AES-CBC data must be whole blocks");
	const last = data.subarray(data.length - 16);
	const x = new Uint8Array(16);
	for (let k = 0; k < 16; k++) x[k] = last[k] ^ 0x10;
	// E(x) is the first block of the CBC encryption of x under a zero IV.
	const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, key, x));
	const probe = new Uint8Array(data.length + 16);
	probe.set(data);
	probe.set(encrypted.subarray(0, 16), data.length);
	return aesCbcDecrypt(key, probe);
}

/** Decrypts only the first 16-byte block of `data`, without looking at padding. */
export function aesCbcDecryptFirstBlock(key: CryptoKey, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	return aesCbcDecryptRaw(key, data.subarray(0, 16));
}
