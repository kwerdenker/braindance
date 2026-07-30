// Wire format shared by the native grabber, the recorder and the replayer.
//
//   [u32 magic 'KNCT'][u32 type][u32 payloadLen][payload]

export const MAGIC = 0x4b4e4354;
export const TYPE_HELLO = 1;
export const TYPE_FRAME = 2;
export const HEADER_BYTES = 12;

/**
 * Reassembles whole messages from arbitrary chunk boundaries. A 500KB frame is
 * always split across many `data` events, so one chunk never equals one frame.
 */
export class MessageParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** @returns {Array<{type: number, payload: Buffer, raw: Buffer}>} */
  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out = [];

    while (this.buf.length >= HEADER_BYTES) {
      const magic = this.buf.readUInt32LE(0);
      if (magic !== MAGIC) {
        throw new Error(`stream desync: expected magic KNCT, got 0x${magic.toString(16)}`);
      }
      const type = this.buf.readUInt32LE(4);
      const len = this.buf.readUInt32LE(8);
      const total = HEADER_BYTES + len;
      if (this.buf.length < total) break; // wait for the rest

      out.push({
        type,
        payload: this.buf.subarray(HEADER_BYTES, total),
        raw: this.buf.subarray(0, total),
      });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

export function encodeMessage(type, payload) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(type, 4);
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, payload]);
}
