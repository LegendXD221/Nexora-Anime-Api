const getCryptoSubtle = (): SubtleCrypto => {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('Web Crypto API (subtle) is not available in this environment.');
};

export async function aesDecrypt(
  ciphertextBase64: string,
  keyStr: string,
  ivStr: string,
): Promise<string> {
  const subtle = getCryptoSubtle();
  const keyBuffer = new TextEncoder().encode(keyStr);
  const ivBuffer = new TextEncoder().encode(ivStr);

  const key = await subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);

  // Decode base64 to Uint8Array
  const binaryString = atob(ciphertextBase64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const decryptedBuffer = await subtle.decrypt({ name: 'AES-CBC', iv: ivBuffer }, key, bytes);

  // Strip null bytes and any control characters (0x00 - 0x10) that might be left from padding
  const decryptedText = new TextDecoder().decode(decryptedBuffer);
  return decryptedText.replace(/[\x00-\x10]/g, '');
}

export async function aesEncrypt(
  plaintext: string,
  keyStr: string,
  ivStr: string,
): Promise<string> {
  const subtle = getCryptoSubtle();
  const keyBuffer = new TextEncoder().encode(keyStr);
  const ivBuffer = new TextEncoder().encode(ivStr);

  const key = await subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['encrypt']);

  const plaintextBytes = new TextEncoder().encode(plaintext);

  const encryptedBuffer = await subtle.encrypt(
    { name: 'AES-CBC', iv: ivBuffer },
    key,
    plaintextBytes,
  );

  // Encode Uint8Array to base64
  const bytes = new Uint8Array(encryptedBuffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function sha256(text: string): Promise<Uint8Array> {
  const subtle = getCryptoSubtle();
  const data = new TextEncoder().encode(text);
  const hashBuffer = await subtle.digest('SHA-256', data);
  return new Uint8Array(hashBuffer);
}

export async function aesDecryptCtr(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getCryptoSubtle();
  const importedKey = await subtle.importKey('raw', key as any, { name: 'AES-CTR' }, false, [
    'decrypt',
  ]);
  const decryptedBuffer = await subtle.decrypt(
    { name: 'AES-CTR', counter: iv as any, length: 64 },
    importedKey,
    ciphertext as any,
  );
  return new Uint8Array(decryptedBuffer);
}
