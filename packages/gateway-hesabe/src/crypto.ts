import {
  bytesToHex,
  hexToBytes,
  InvalidRequestError,
  utf8Encode,
  type CryptoProvider,
} from "@paykernel/core";

function requireSubtle(crypto: CryptoProvider): SubtleCrypto {
  if (crypto.subtle === undefined) {
    throw new InvalidRequestError(
      "Hesabe encryption requires WebCrypto subtle (inject runtime.crypto)",
    );
  }
  return crypto.subtle;
}

function keyBytes(key: string): Uint8Array {
  const bytes = utf8Encode(key);
  if (bytes.length !== 32) {
    throw new InvalidRequestError("Hesabe encryptionKey must be 32 UTF-8 bytes");
  }
  return bytes;
}

function ivBytes(iv: string): Uint8Array {
  const bytes = utf8Encode(iv);
  if (bytes.length !== 16) {
    throw new InvalidRequestError("Hesabe iv must be 16 UTF-8 bytes");
  }
  return bytes;
}

function assertHexPayload(hex: string): Uint8Array {
  const trimmed = hex.trim();
  if (trimmed.length === 0 || trimmed.length % 2 !== 0) {
    throw new InvalidRequestError("Hesabe payload is not valid hex");
  }
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new InvalidRequestError("Hesabe payload is not valid hex");
  }
  const bytes = hexToBytes(trimmed.toLowerCase());
  if (bytes.length % 16 !== 0) {
    throw new InvalidRequestError("Hesabe payload has an invalid block size");
  }
  return bytes;
}

function stripLegacyPadding(padded: Uint8Array): ArrayBuffer {
  const pad = padded.at(-1) ?? 0;
  if (
    padded.length % 32 !== 0 ||
    pad < 17 ||
    pad > 32 ||
    !padded.slice(-pad).every((byte) => byte === pad)
  ) {
    throw new Error("Invalid legacy padding");
  }
  return padded.slice(0, -pad).buffer as ArrayBuffer;
}

async function importAesKey(
  subtle: SubtleCrypto,
  key: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const encodedKey = keyBytes(key);
  try {
    return await subtle.importKey("raw", encodedKey as BufferSource, { name: "AES-CBC" }, false, [
      usage,
    ]);
  } catch {
    // Crypto implementations may include supplied material in their exceptions.
    throw new InvalidRequestError("Hesabe encryption key could not be imported");
  }
}

/**
 * Standard AES-256-CBC / PKCS#7 encrypt (WebCrypto pads) to lowercase hex.
 * Key is 32 UTF-8 bytes, IV is 16 UTF-8 bytes. No manual padding: WebCrypto
 * applies PKCS#7 exactly once.
 */
export async function hesabeEncrypt(
  plaintext: string,
  key: string,
  iv: string,
  crypto: CryptoProvider,
): Promise<string> {
  const subtle = requireSubtle(crypto);
  const imported = await importAesKey(subtle, key, "encrypt");
  let cipher: ArrayBuffer;
  try {
    cipher = await subtle.encrypt(
      { name: "AES-CBC", iv: ivBytes(iv) as BufferSource },
      imported,
      utf8Encode(plaintext) as BufferSource,
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidRequestError("Hesabe encryption failed");
    }
    throw error;
  }
  return bytesToHex(new Uint8Array(cipher));
}

/**
 * AES-256-CBC decrypt from hex. Hesabe also emits a legacy 32-byte padded
 * response; accept that form only when normal PKCS#7 decryption fails.
 * Reject bad hex, block size, padding, and non-UTF8 plaintext.
 */
export async function hesabeDecrypt(
  hex: string,
  key: string,
  iv: string,
  crypto: CryptoProvider,
): Promise<string> {
  const subtle = requireSubtle(crypto);
  const bytes = assertHexPayload(hex);
  const imported = await importAesKey(subtle, key, "decrypt");
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt(
      { name: "AES-CBC", iv: ivBytes(iv) as BufferSource },
      imported,
      bytes as BufferSource,
    );
  } catch (error) {
    try {
      // WebCrypto always removes PKCS#7 padding. Append one valid AES-CBC
      // block so it removes only that block, exposing Hesabe's original bytes.
      const encryptKey = await importAesKey(subtle, key, "encrypt");
      const finalBlock = await subtle.encrypt(
        { name: "AES-CBC", iv: bytes.slice(-16) as BufferSource },
        encryptKey,
        new Uint8Array(0),
      );
      const extended = new Uint8Array(bytes.length + 16);
      extended.set(bytes);
      extended.set(new Uint8Array(finalBlock), bytes.length);
      const padded = new Uint8Array(
        await subtle.decrypt(
          { name: "AES-CBC", iv: ivBytes(iv) as BufferSource },
          imported,
          extended as BufferSource,
        ),
      );
      plain = stripLegacyPadding(padded);
    } catch {
      if (error instanceof Error) {
        throw new InvalidRequestError("Hesabe payload failed to decrypt");
      }
      throw error;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidRequestError("Hesabe payload is not valid UTF-8");
    }
    throw error;
  }
}

/**
 * Decrypt then JSON-parse, rejecting invalid JSON and non-object payloads.
 * Resolves with a non-null, non-array object.
 */
export async function hesabeDecryptJson(
  hex: string,
  key: string,
  iv: string,
  crypto: CryptoProvider,
): Promise<unknown> {
  const text = await hesabeDecrypt(hex, key, iv, crypto);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidRequestError("Hesabe payload is not valid JSON");
    }
    throw error;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidRequestError("Hesabe payload is not a JSON object");
  }
  return parsed;
}
