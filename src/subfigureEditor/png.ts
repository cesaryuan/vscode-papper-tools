/** Computes the PNG checksum over a chunk's type and payload. */
function crc32(bytes: Uint8Array): number {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit++) result = result >>> 1 ^ (result & 1 ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
}

/** Sets physical DPI metadata so exported PNGs retain the authored print size in image tools. */
export function setPngDpi(source: Uint8Array, dpi: number): Uint8Array {
  const input = Buffer.from(source);
  if (input.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("PNG export failed");
  const data = Buffer.alloc(21);
  data.writeUInt32BE(9, 0); data.write("pHYs", 4);
  data.writeUInt32BE(Math.round(dpi / .0254), 8); data.writeUInt32BE(Math.round(dpi / .0254), 12); data[16] = 1;
  data.writeUInt32BE(crc32(data.subarray(4, 17)), 17);
  const chunks: Buffer[] = [input.subarray(0, 8)];
  let offset = 8, inserted = false;
  while (offset < input.length) {
    const end = offset + input.readUInt32BE(offset) + 12;
    const type = input.toString("ascii", offset + 4, offset + 8);
    if (type !== "pHYs") chunks.push(input.subarray(offset, end));
    if (type === "IHDR" && !inserted) { chunks.push(data); inserted = true; }
    offset = end;
  }
  return Buffer.concat(chunks);
}
