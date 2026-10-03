import { deflateSync, Inflate } from 'fflate'

/*
 * Minimal ZIP writer and central-directory reader.
 *
 * The writer is deterministic by construction: entries are written in the order
 * given, every timestamp is the fixed DOS date FIXED_DOS_DATE/TIME (1980-01-01 00:00),
 * external attributes / version fields are constants, and deflate runs at a fixed
 * level. Same input bytes => same zip bytes => same sha256.
 *
 * The reader parses the central directory itself (instead of a library's high-level
 * unzip) because spec section 4 needs fields high-level APIs hide: general-purpose
 * flags (encryption), compression method, external attributes (symlinks), zip64
 * markers and the local-header/central-directory consistency check.
 */

export const FIXED_DOS_TIME = 0 // 00:00:00
export const FIXED_DOS_DATE = (0 << 9) | (1 << 5) | 1 // 1980-01-01

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50

const FLAG_ENCRYPTED = 0x0001
const FLAG_DATA_DESCRIPTOR = 0x0008
const FLAG_STRONG_ENCRYPTION = 0x0040
const FLAG_UTF8 = 0x0800

export const METHOD_STORED = 0
export const METHOD_DEFLATE = 8

/* ------------------------------------------------------------------ crc32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/* ------------------------------------------------------------------ writer */

/**
 * @param {Array<{ path: string, data: Uint8Array }>} files written in this exact order
 * @param {object} [options]
 * @param {(file) => object} [options.raw] test hook: per-entry overrides
 *   ({ nameBytes, method, flags, externalAttrs, versionMadeBy, declaredSize, compressedData })
 *   used to craft malformed packages. Never used by `pack`.
 */
export function writeZip(files, options = {}) {
  const encoder = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0

  for (const file of files) {
    const override = options.raw ? options.raw(file) || {} : {}
    const nameBytes = override.nameBytes || encoder.encode(file.path)
    const data = file.data
    let method = override.method
    let compressed = override.compressedData
    if (method === undefined) {
      // Deflate unless it does not help, or would exceed the spec's 100:1 ratio cap
      // (a highly repetitive file is stored rather than rejected as a "bomb").
      const deflated = data.length > 0 ? deflateSync(data, { level: 9 }) : data
      const useDeflate = deflated.length < data.length && data.length / deflated.length <= 100
      method = useDeflate ? METHOD_DEFLATE : METHOD_STORED
      compressed = compressed || (useDeflate ? deflated : data)
    }
    if (!compressed) compressed = method === METHOD_DEFLATE ? deflateSync(data, { level: 9 }) : data
    const crc = crc32(data)
    const flags = override.flags ?? (/[^\x00-\x7f]/.test(file.path) ? FLAG_UTF8 : 0)
    const uncompressedSize = override.declaredSize ?? data.length
    const versionMadeBy = override.versionMadeBy ?? 20 // MS-DOS host, spec 2.0
    const externalAttrs = override.externalAttrs ?? 0

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, SIG_LOCAL, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, FIXED_DOS_TIME, true)
    lv.setUint16(12, FIXED_DOS_DATE, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, compressed.length, true)
    lv.setUint32(22, uncompressedSize, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, SIG_CENTRAL, true)
    cv.setUint16(4, versionMadeBy, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, flags, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, FIXED_DOS_TIME, true)
    cv.setUint16(14, FIXED_DOS_DATE, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, compressed.length, true)
    cv.setUint32(24, uncompressedSize, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, externalAttrs >>> 0, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    locals.push(local, compressed)
    centrals.push(central)
    offset += local.length + compressed.length
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, SIG_EOCD, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  return concat([...locals, ...centrals, eocd])
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/* ------------------------------------------------------------------ reader */

export class ZipFormatError extends Error {
  constructor(code, message, path) {
    super(message)
    this.code = code
    this.path = path
  }
}

/**
 * Parse the central directory. Throws ZipFormatError(PLUGIN_PACKAGE_INVALID) for
 * anything that is not a plain single-volume, non-zip64 archive.
 * Returns raw entries; policy (paths, whitelist, sizes) is the caller's job.
 */
export function readCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const invalid = (message, path) => new ZipFormatError('PLUGIN_PACKAGE_INVALID', message, path)

  // EOCD: last 22 bytes + up to 65535 bytes of comment.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw invalid('not a zip archive (end of central directory not found)')
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_EOCD_LOCATOR) throw invalid('zip64 archives are not supported')

  const diskNumber = view.getUint16(eocd + 4, true)
  const cdDisk = view.getUint16(eocd + 6, true)
  const entriesOnDisk = view.getUint16(eocd + 8, true)
  const entryCount = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== entryCount) throw invalid('multi-volume archives are not supported')
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw invalid('zip64 archives are not supported')
  if (cdOffset + cdSize > eocd) throw invalid('central directory lies outside the archive')

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries = []
  let at = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== SIG_CENTRAL) throw invalid('corrupt central directory')
    const versionMadeBy = view.getUint16(at + 4, true)
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const compressedSize = view.getUint32(at + 20, true)
    const uncompressedSize = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const diskStart = view.getUint16(at + 34, true)
    const externalAttrs = view.getUint32(at + 38, true)
    const localOffset = view.getUint32(at + 42, true)
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength)
    const extra = bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)

    let name
    try {
      name = decoder.decode(nameBytes)
    } catch {
      throw new ZipFormatError('PLUGIN_PACKAGE_UNSAFE_PATH', 'entry name is not valid UTF-8')
    }
    // Like the server, names are decoded as strict UTF-8 whatever bit 11 says; a name
    // that is not valid UTF-8 (e.g. legacy CP437/GBK bytes) was refused above.
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw invalid('encrypted entries are not supported', name)
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) throw invalid(`unsupported compression method ${method} (only stored/deflate)`, name)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff || hasExtraField(extra, 0x0001)) {
      throw invalid('zip64 entries are not supported', name)
    }
    if (diskStart !== 0) throw invalid('multi-volume archives are not supported', name)

    entries.push({
      name,
      nameBytes,
      versionMadeBy,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      externalAttrs,
      localOffset,
    })
    at += 46 + nameLength + extraLength + commentLength
  }

  // Local headers must agree with the central directory, and data must lie inside the file.
  for (const entry of entries) {
    const lo = entry.localOffset
    if (lo + 30 > cdOffset || view.getUint32(lo, true) !== SIG_LOCAL) throw invalid('local header missing or corrupt', entry.name)
    const lFlags = view.getUint16(lo + 6, true)
    const lMethod = view.getUint16(lo + 8, true)
    const lNameLength = view.getUint16(lo + 26, true)
    const lExtraLength = view.getUint16(lo + 28, true)
    const lName = bytes.subarray(lo + 30, lo + 30 + lNameLength)
    if (lMethod !== entry.method || !equalBytes(lName, entry.nameBytes) || (lFlags & FLAG_ENCRYPTED) !== (entry.flags & FLAG_ENCRYPTED)) {
      throw invalid('local header disagrees with central directory', entry.name)
    }
    if ((lFlags & FLAG_DATA_DESCRIPTOR) === 0) {
      const lCrc = view.getUint32(lo + 14, true)
      const lCompressed = view.getUint32(lo + 18, true)
      const lUncompressed = view.getUint32(lo + 22, true)
      if (lCrc !== entry.crc || lCompressed !== entry.compressedSize || lUncompressed !== entry.uncompressedSize) {
        throw invalid('local header disagrees with central directory', entry.name)
      }
    }
    entry.dataOffset = lo + 30 + lNameLength + lExtraLength
    if (entry.dataOffset + entry.compressedSize > cdOffset) throw invalid('entry data overruns the archive', entry.name)
  }

  return entries
}

/**
 * Decompress one entry with a hard output cap (its declared size). A stream that
 * inflates past the declared size is a bomb even if the declared ratio looked fine.
 */
export function readEntryData(bytes, entry) {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  let data
  if (entry.method === METHOD_STORED) {
    data = compressed
  } else {
    const limit = entry.uncompressedSize
    const chunks = []
    let total = 0
    let overflow = false
    const inflater = new Inflate((chunk) => {
      if (overflow) return
      total += chunk.length
      if (total > limit) {
        overflow = true
        return
      }
      chunks.push(chunk)
    })
    try {
      const STEP = 16 * 1024
      for (let i = 0; i < compressed.length && !overflow; i += STEP) {
        const end = Math.min(compressed.length, i + STEP)
        inflater.push(compressed.subarray(i, end), end === compressed.length)
      }
    } catch (error) {
      throw new ZipFormatError('PLUGIN_PACKAGE_INVALID', `corrupt deflate stream: ${error.message}`, entry.name)
    }
    if (overflow) throw new ZipFormatError('PLUGIN_PACKAGE_BOMB', 'entry inflates beyond its declared size', entry.name)
    data = concat(chunks)
  }
  if (data.length !== entry.uncompressedSize) throw new ZipFormatError('PLUGIN_PACKAGE_INVALID', 'entry size does not match its declared size', entry.name)
  if (crc32(data) !== entry.crc) throw new ZipFormatError('PLUGIN_PACKAGE_INVALID', 'entry CRC mismatch', entry.name)
  return data
}

function hasExtraField(extra, id) {
  let i = 0
  while (i + 4 <= extra.length) {
    const fieldId = extra[i] | (extra[i + 1] << 8)
    const size = extra[i + 2] | (extra[i + 3] << 8)
    if (fieldId === id) return true
    i += 4 + size
  }
  return false
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
