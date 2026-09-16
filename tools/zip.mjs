/*
 * A small ZIP writer.
 *
 * Windows' own Compress-Archive writes nested paths with backslashes, which
 * the format does not allow: unzip warns about it and some tools — the ones a
 * macOS user is most likely to have — can end up with a single file literally
 * named "Figma plugin\dist\code.js" instead of a folder. The download is the
 * one artefact every user touches, so it is built here instead, with forward
 * slashes and nothing else surprising in it.
 */
import { deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* CRC-32 (IEEE 802.3), the checksum every ZIP entry carries. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packs a timestamp into two 16-bit words, with two-second resolution. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Every file under `dir`, as { name, path } with ZIP-shaped names. */
export function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) out.push(...walk(path, name + "/"));
    else out.push({ name, path });
  }
  return out;
}

/**
 * Write `files` (from walk(), or any {name, path} list) to `outFile`.
 * Names are used exactly as given, so pass them with forward slashes.
 */
export function writeZip(outFile, files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name.split("\\").join("/"), "utf8");
    const body = readFileSync(file.path);
    const deflated = deflateRawSync(body, { level: 9 });
    /* Deflate can grow a small or already-compressed file; store it then. */
    const stored = deflated.length >= body.length;
    const data = stored ? body : deflated;
    const stamp = dosStamp(statSync(file.path).mtime);
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed: 2.0
    local.writeUInt16LE(0x0800, 6);       // flags: names are UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8); // method: store or deflate
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field
    locals.push(local, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);   // central directory header
    entry.writeUInt16LE(20, 4);           // made by 2.0, MS-DOS
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(stamp.time, 12);
    entry.writeUInt16LE(stamp.date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0, 36);           // external attributes: a plain file
    entry.writeUInt32LE(offset, 42);      // where its local header starts
    central.push(entry, name);

    offset += local.length + name.length + data.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);

  writeFileSync(outFile, Buffer.concat([...locals, dir, end]));
  return statSync(outFile).size;
}
