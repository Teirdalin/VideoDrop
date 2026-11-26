import { deflateRawSync } from "node:zlib";
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1));
  return n >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export function zipEntries(entries) {
  let offset = 0; const local = [], central = [];
  for (const entry of entries) {
    if (entry.name.startsWith("/") || entry.name.split("/").includes("..") || entry.name.includes("\\")) throw new Error("Unsafe archive entry");
    const name = Buffer.from(entry.name), compressed = deflateRawSync(entry.data, { level: 9 });
    const packed = compressed.length < entry.data.length ? compressed : entry.data;
    const method = packed === compressed ? 8 : 0, checksum = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(method, 8); header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(method, 10); directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
