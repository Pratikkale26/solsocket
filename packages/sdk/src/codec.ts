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

/** Pass-through codec for apps that manage their own bytes. */
export const rawCodec: Codec<Uint8Array> = {
  encode: (v) => v,
  decode: (b) => b,
};

/** Field types for `structCodec`. Borsh-style wire format: little-endian
 *  integers/floats, bool as one byte, string as u32 length + UTF-8. */
export type StructField =
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "f32"
  | "f64"
  | "bool"
  | "string";

const FIXED_SIZE: Record<Exclude<StructField, "string">, number> = {
  u8: 1,
  i8: 1,
  bool: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  f64: 8,
};

/**
 * Compact binary codec for flat structs — presence payloads where bytes
 * matter (a cursor drops from ~24 JSON bytes to 8). Field order defines the
 * wire layout, so keep it stable across clients:
 *
 *   const avatar = structCodec<{ x: number; y: number; facing: number; name: string }>([
 *     ["x", "u16"], ["y", "u16"], ["facing", "u8"], ["name", "string"],
 *   ]);
 */
export function structCodec<T extends Record<string, number | boolean | string>>(
  fields: [keyof T & string, StructField][],
): Codec<T> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  return {
    encode(value) {
      let size = 0;
      const strings = new Map<string, Uint8Array>();
      for (const [key, type] of fields) {
        if (type === "string") {
          const bytes = enc.encode(String(value[key]));
          strings.set(key, bytes);
          size += 4 + bytes.length;
        } else {
          size += FIXED_SIZE[type];
        }
      }
      const out = new Uint8Array(size);
      const view = new DataView(out.buffer);
      let o = 0;
      for (const [key, type] of fields) {
        const v = value[key];
        switch (type) {
          case "u8": view.setUint8(o, v as number); o += 1; break;
          case "i8": view.setInt8(o, v as number); o += 1; break;
          case "bool": view.setUint8(o, v ? 1 : 0); o += 1; break;
          case "u16": view.setUint16(o, v as number, true); o += 2; break;
          case "i16": view.setInt16(o, v as number, true); o += 2; break;
          case "u32": view.setUint32(o, v as number, true); o += 4; break;
          case "i32": view.setInt32(o, v as number, true); o += 4; break;
          case "f32": view.setFloat32(o, v as number, true); o += 4; break;
          case "f64": view.setFloat64(o, v as number, true); o += 8; break;
          case "string": {
            const bytes = strings.get(key)!;
            view.setUint32(o, bytes.length, true); o += 4;
            out.set(bytes, o); o += bytes.length;
            break;
          }
        }
      }
      return out;
    },

    decode(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const value: Record<string, number | boolean | string> = {};
      let o = 0;
      for (const [key, type] of fields) {
        switch (type) {
          case "u8": value[key] = view.getUint8(o); o += 1; break;
          case "i8": value[key] = view.getInt8(o); o += 1; break;
          case "bool": value[key] = view.getUint8(o) !== 0; o += 1; break;
          case "u16": value[key] = view.getUint16(o, true); o += 2; break;
          case "i16": value[key] = view.getInt16(o, true); o += 2; break;
          case "u32": value[key] = view.getUint32(o, true); o += 4; break;
          case "i32": value[key] = view.getInt32(o, true); o += 4; break;
          case "f32": value[key] = view.getFloat32(o, true); o += 4; break;
          case "f64": value[key] = view.getFloat64(o, true); o += 8; break;
          case "string": {
            const len = view.getUint32(o, true); o += 4;
            value[key] = dec.decode(bytes.subarray(o, o + len)); o += len;
            break;
          }
        }
      }
      return value as T;
    },
  };
}
