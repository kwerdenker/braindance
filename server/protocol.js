// Wire format shared by the native grabber, the recorder and the replayer.
//
//   [u32 magic 'KNCT'][u32 type][u32 payloadLen][payload]

export const MAGIC = 0x4b4e4354;
export const TYPE_HELLO = 1;
export const TYPE_FRAME = 2;
// The colour camera's own picture, at its native 1920x1080, for the webcam output.
//
// **A separate message rather than a second field on the frame, because it is a
// different picture of a different thing.** Type 2 carries the *registered* colour:
// `Registration::apply`'s resample of the colour camera into the depth camera's
// viewpoint, which is a texture for the point cloud - it wears the depth camera's
// 70.6 degree frustum instead of the colour camera's 84.1, and it is punched through
// with holes wherever the depth solve returned nothing for a ray to carry colour on.
// Useful for shading a cloud, useless as a picture of a room.
//
// **It is live-only: the recorder never writes one.** A capture file is the wire
// verbatim, so a type 3 landing in one would move every take's content hash, and that
// hash is the key the library joins two machines on. `vcam-check --mutate
// hd-reaches-recorder` is the arm that fails if this ever stops being true. Recording
// it is a decision nobody has taken - see issue #9.
//
// Emitted only while something is subscribed, because at roughly 215KB a frame it is
// another ~50Mbit/s on a pipe whose backpressure reaches the grabber and costs the
// take. The server asks for it over the grabber's stdin command channel.
export const TYPE_COLOR = 3;
export const HEADER_BYTES = 12;

// The largest payload this format admits, and the reason it needs one at all:
// `payloadLen` is a u32 off the wire, so a desynced stream can declare four
// gigabytes and the reassembly below would buffer toward it a chunk at a time,
// holding every byte for a message that is never going to be whole. A frame is a
// 512x424 depth grid plus a JPEG - 486KB measured on this sensor - a hello is a few
// hundred bytes of JSON, and a 1080p colour message measures about 215KB, so eight
// megabytes is more than an order of magnitude of headroom over anything this format
// has ever carried, and a length past it is a lie rather than a large frame. Named
// here rather than in either reader, because the live parser and the sidecar index
// are both bounded by the same fact about the format.
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

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
      // Refused before a byte of it is buffered, which is the whole point of
      // checking here rather than where the payload is used. The loop below waits
      // for `total` bytes and concatenates every chunk until it has them, so a
      // declared length of 0xffffffff is this process growing toward 4 GiB while the
      // sender goes quiet - no error, no frame, just a buffer nobody bounds. A
      // desynced stream that landed on plausible magic is the ordinary way to arrive
      // here, and the caller treats a throw as a reason to restart the grabber,
      // which is what rebuilds the framing.
      if (len > MAX_PAYLOAD_BYTES) {
        throw new Error(
          `a message declares ${len} payload bytes, past the ${MAX_PAYLOAD_BYTES} this format allows: `
          + 'refusing rather than buffering toward it',
        );
      }
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
