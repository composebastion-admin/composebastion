type BrowserCrypto = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
};

function hexByte(value: number) {
  return value.toString(16).padStart(2, "0");
}

function uuidFromRandomValues(cryptoSource: BrowserCrypto) {
  const bytes = cryptoSource.getRandomValues?.(new Uint8Array(16));
  if (!bytes) return null;

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, hexByte);
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function createClientId(cryptoSource: BrowserCrypto | null | undefined = globalThis.crypto) {
  const uuid = cryptoSource?.randomUUID?.();
  if (uuid) return uuid;

  const randomValueUuid = cryptoSource ? uuidFromRandomValues(cryptoSource) : null;
  if (randomValueUuid) return randomValueUuid;

  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
