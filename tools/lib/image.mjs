import { crc32 } from './zip.mjs'

/*
 * Icon format/size probe (spec section 4 step 7). Structural only: it walks the
 * container and reads declared dimensions, it does not decode pixels. The server
 * decodes; this is a local early warning.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** @returns {{ format: 'png'|'webp', width: number, height: number, animated: boolean }} or throws Error */
export function probeImage(bytes) {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return probePng(bytes)
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return probeWebp(bytes)
  throw new Error('not a PNG or WebP image')
}

function probePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8
  let width = 0
  let height = 0
  let sawIhdr = false
  let sawIdat = false
  let animated = false
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at)
    const type = ascii(bytes, at + 4, 4)
    if (at + 12 + length > bytes.length) throw new Error(`PNG chunk ${type} is truncated`)
    const expected = view.getUint32(at + 8 + length)
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== expected) throw new Error(`PNG chunk ${type} has a bad CRC`)
    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13) throw new Error('PNG must start with an IHDR chunk')
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      sawIhdr = true
    }
    if (type === 'IDAT') sawIdat = true
    if (type === 'acTL') animated = true
    if (type === 'IEND') {
      if (!sawIdat) throw new Error('PNG has no image data')
      if (width === 0 || height === 0) throw new Error('PNG has zero dimensions')
      return { format: 'png', width, height, animated }
    }
    at += 12 + length
  }
  throw new Error('PNG is truncated (no IEND chunk)')
}

function probeWebp(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const riffSize = view.getUint32(4, true)
  if (riffSize + 8 > bytes.length) throw new Error('WebP is truncated')
  const chunk = ascii(bytes, 12, 4)
  const data = 20
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[data + 4] | (bytes[data + 5] << 8) | (bytes[data + 6] << 16))
    const height = 1 + (bytes[data + 7] | (bytes[data + 8] << 8) | (bytes[data + 9] << 16))
    return { format: 'webp', width, height, animated: (bytes[data] & 0x02) !== 0 }
  }
  if (chunk === 'VP8L') {
    if (bytes[data] !== 0x2f) throw new Error('WebP lossless signature missing')
    const bits = view.getUint32(data + 1, true)
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false }
  }
  if (chunk === 'VP8 ') {
    if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) throw new Error('WebP lossy start code missing')
    return { format: 'webp', width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff, animated: false }
  }
  throw new Error(`unknown WebP chunk '${chunk}'`)
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}
