import { describe, it, expect } from "bun:test";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { InvalidRequestError, type CryptoProvider } from "@paykernel/core";
import { hesabeDecrypt, hesabeDecryptJson, hesabeEncrypt } from "./crypto";

const KEY = "PkW64zMe5NVdrlPVNnjo2Jy9nOb7v1Xg";
const IV = "5NVdrlPVNnjo2Jy9";
const PLAINTEXT =
  '{"merchantCode":"842217","refundAmount":"10.000","refundMethod":"1","token":"84221717575602869376365549977"}';
const FIXTURE_HEX =
  "0e7898bd7464d0c402fe8a949d9cbf9ba5d8ada481ab9f66e4555139335643f4e1904f125c6dac14503369ecf3f06cde1212ac5fdaef94ab225673f757a5a84ee182f9443ce727161e9720f0cb138e5d51a6a728003af542dec35e6a9d8eedae76430e633696b35aca4267c9a2cbb0e3";

const provider = globalThis.crypto as unknown as CryptoProvider;

function nodeEncryptHex(plaintext: string): string {
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(KEY, "utf8"), Buffer.from(IV, "utf8"));
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("hex");
}

function nodeDecryptHex(hex: string): string {
  const decipher = createDecipheriv(
    "aes-256-cbc",
    Buffer.from(KEY, "utf8"),
    Buffer.from(IV, "utf8"),
  );
  return Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]).toString(
    "utf8",
  );
}

function nodeEncryptBytesToHex(bytes: Buffer): string {
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(KEY, "utf8"), Buffer.from(IV, "utf8"));
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString("hex");
}

describe("hesabe AES-256-CBC fixtures", () => {
  it("decrypts the official docs vector", async () => {
    await expect(hesabeDecrypt(FIXTURE_HEX, KEY, IV, provider)).resolves.toBe(PLAINTEXT);
  });

  it("encrypts to the official docs vector (no double padding)", async () => {
    await expect(hesabeEncrypt(PLAINTEXT, KEY, IV, provider)).resolves.toBe(FIXTURE_HEX);
  });

  it("matches Node ciphertext for the docs plaintext (independent crosscheck)", () => {
    expect(nodeEncryptHex(PLAINTEXT)).toBe(FIXTURE_HEX);
    expect(nodeDecryptHex(FIXTURE_HEX)).toBe(PLAINTEXT);
  });

  it.each([
    { name: "empty", text: "" },
    { name: "1 byte", text: "x" },
    { name: "15 bytes", text: "123456789012345" },
    { name: "16 bytes", text: "1234567890123456" },
    { name: "17 bytes", text: "12345678901234567" },
    { name: "31 bytes", text: "1234567890123456789012345678901" },
    { name: "32 bytes", text: "12345678901234567890123456789012" },
    { name: "unicode", text: "مرحبا 🌙 Hesabe ✓ — 842217" },
  ])("round-trips $name against Node, not itself", async ({ text }) => {
    const expectedHex = nodeEncryptHex(text);
    const actualHex = await hesabeEncrypt(text, KEY, IV, provider);
    expect(actualHex).toBe(expectedHex);
    await expect(hesabeDecrypt(expectedHex, KEY, IV, provider)).resolves.toBe(text);
    expect(nodeDecryptHex(actualHex)).toBe(text);
  });
});

describe("hesabe decrypt rejections", () => {
  it.each([
    { name: "empty string", hex: "" },
    { name: "odd length", hex: "0" },
    { name: "non-hex chars", hex: "zz".repeat(16) },
  ])("rejects bad hex $name", async ({ hex }) => {
    await expect(hesabeDecrypt(hex, KEY, IV, provider)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it.each([
    { name: "1 byte", hex: "00" },
    { name: "3 bytes", hex: "001122" },
  ])("rejects bad block size $name", async ({ hex }) => {
    await expect(hesabeDecrypt(hex, KEY, IV, provider)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("rejects tampered padding", async () => {
    const tampered = FIXTURE_HEX.slice(0, -2) + (FIXTURE_HEX.endsWith("00") ? "01" : "00");
    await expect(hesabeDecrypt(tampered, KEY, IV, provider)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it.each([
    { name: "short key", key: "short", iv: IV },
    { name: "short iv", key: KEY, iv: "short" },
    // UTF-16 length is 32, but the UTF-8 encoding occupies 34 bytes.
    { name: "multibyte key over 32 bytes", key: `${"a".repeat(30)}🌙`, iv: IV },
  ])("rejects wrong key/iv byte length $name", async ({ key, iv }) => {
    await expect(hesabeDecrypt(FIXTURE_HEX, key, iv, provider)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it("rejects non-UTF8 plaintext", async () => {
    const raw = Buffer.from(new Array(16).fill(0xff));
    const hex = nodeEncryptBytesToHex(raw);
    await expect(hesabeDecrypt(hex, KEY, IV, provider)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("requires WebCrypto subtle", async () => {
    const noSubtle = {
      randomUUID: () => "00000000-0000-0000-0000-000000000000",
      getRandomValues: <T extends ArrayBufferView>(array: T): T => array,
    } as CryptoProvider;
    await expect(hesabeDecrypt(FIXTURE_HEX, KEY, IV, noSubtle)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    await expect(hesabeEncrypt("hi", KEY, IV, noSubtle)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });
});

describe("hesabeDecryptJson", () => {
  it("returns objects", async () => {
    const hex = nodeEncryptHex('{"ok":true,"n":1}');
    const parsed = (await hesabeDecryptJson(hex, KEY, IV, provider)) as Record<string, unknown>;
    expect(parsed).toEqual({ ok: true, n: 1 });
  });

  it("rejects invalid JSON", async () => {
    const hex = nodeEncryptHex("not json {");
    await expect(hesabeDecryptJson(hex, KEY, IV, provider)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it.each([
    { name: "null", text: "null" },
    { name: "array", text: "[1,2]" },
    { name: "string", text: '"str"' },
    { name: "number", text: "42" },
    { name: "boolean", text: "true" },
  ])("rejects non-object JSON $name", async ({ text }) => {
    const hex = nodeEncryptHex(text);
    await expect(hesabeDecryptJson(hex, KEY, IV, provider)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });
});

it.each([
  {
    name: "encryption",
    run: (crypto: CryptoProvider) => hesabeEncrypt(PLAINTEXT, KEY, IV, crypto),
  },
  {
    name: "decryption",
    run: (crypto: CryptoProvider) => hesabeDecrypt(FIXTURE_HEX, KEY, IV, crypto),
  },
])("redacts key import errors during $name", async ({ run }) => {
  const failing = {
    subtle: {
      importKey: async () => {
        throw new Error(`Rejected key: ${KEY}`);
      },
    },
  } as unknown as CryptoProvider;
  const error = await run(failing).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(InvalidRequestError);
  expect(String(error)).not.toContain(KEY);
  expect(JSON.stringify(error)).not.toContain(KEY);
});
