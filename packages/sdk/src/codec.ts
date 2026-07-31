/** Encodes app-level values into the byte blobs the room engine stores. */
export interface Codec<T> {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

/** Default codec: JSON over UTF-8. Swap for a binary codec when bytes matter. */
export function jsonCodec<T>(): Codec<T> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    encode: (value) => enc.encode(JSON.stringify(value)),
    decode: (bytes) =>
      bytes.length === 0 ? (undefined as T) : (JSON.parse(dec.decode(bytes)) as T),
  };
}

export const rawCodec: Codec<Uint8Array> = {
  encode: (v) => v,
  decode: (b) => b,
};
