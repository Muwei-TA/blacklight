/**
 * 受控图片处理：只接受 JPEG/PNG，解码后统一重编码为 JPEG。
 *
 * 这个模块保持纯函数，不读取数据库、CloudBase 或环境变量，便于 API、worker
 * 与本地测试复用。magic bytes 与头部像素检查必须早于解码，防止伪造格式和
 * 超大尺寸压缩图触发不受控的内存分配。
 */

const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const MAX_DECODED_BYTES = 2 * 1024 * 1024;
const MAX_WIDTH = 4096;
const MAX_HEIGHT = 4096;
const MAX_PIXELS = 12 * 1024 * 1024;
const JPEG_QUALITY = 85;
const JPEG_MIME = 'image/jpeg';
const PNG_MIME = 'image/png';
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

class ImageProcessingError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ImageProcessingError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new ImageProcessingError(code, message, detail);
}

function assertDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail('invalid_dimensions', '图片尺寸不合法');
  }
  if (width > MAX_WIDTH || height > MAX_HEIGHT || width * height > MAX_PIXELS) {
    fail('pixel_limit', '图片像素尺寸超过限制', { width, height, maxPixels: MAX_PIXELS });
  }
}

function isPng(buffer) {
  return buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
}

function readPngInfo(buffer) {
  if (!isPng(buffer) || buffer.toString('ascii', 12, 16) !== 'IHDR') fail('invalid_image', 'PNG 文件头不合法');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assertDimensions(width, height);
  return { format: 'png', mimeType: PNG_MIME, width, height, hasExif: false };
}

function isJpeg(buffer) {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function readJpegInfo(buffer) {
  if (!isJpeg(buffer)) fail('invalid_image', 'JPEG 文件头不合法');
  let offset = 2;
  let width = 0;
  let height = 0;
  let hasExif = false;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;

    // Standalone markers do not carry a segment length.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 2 > buffer.length) fail('invalid_image', 'JPEG 段长度缺失');
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) fail('invalid_image', 'JPEG 段长度不合法');

    if (marker === 0xe1 && segmentLength >= 8 && buffer.toString('ascii', offset + 2, offset + 8) === 'Exif\0\0') {
      hasExif = true;
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) fail('invalid_image', 'JPEG 尺寸段不完整');
      height = buffer.readUInt16BE(offset + 3);
      width = buffer.readUInt16BE(offset + 5);
      assertDimensions(width, height);
    }
    offset += segmentLength;
    // The entropy-coded payload begins after SOS. Any metadata segment that
    // matters for this boundary must precede it, so avoid scanning arbitrary
    // compressed bytes after dimensions are known.
    if (marker === 0xda) break;
  }
  if (!width || !height) fail('invalid_image', 'JPEG 未找到有效尺寸段');
  return {
    format: 'jpeg',
    mimeType: JPEG_MIME,
    width,
    height,
    hasExif,
  };
}

function inspectImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('invalid_image', '图片内容不是二进制数据');
  if (buffer.length === 0) fail('invalid_image', '图片内容为空');
  if (isPng(buffer)) return readPngInfo(buffer);
  if (isJpeg(buffer)) return readJpegInfo(buffer);
  fail('unsupported_type', '只支持 JPEG 或 PNG 图片');
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('invalid_base64', '缺少图片内容');
  const trimmed = value.trim();
  const dataUrl = trimmed.match(/^data:([^;,]+);base64,(.*)$/is);
  const declaredMimeType = dataUrl ? dataUrl[1].toLowerCase() : '';
  const encoded = (dataUrl ? dataUrl[2] : trimmed).replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    fail('invalid_base64', '图片编码不合法');
  }
  // Reject oversized input before Buffer.from allocates memory for it. The
  // small padding margin permits the normal `=` suffix without changing the
  // decoded 2 MiB ceiling.
  const maxEncodedLength = Math.ceil(MAX_DECODED_BYTES / 3) * 4 + 4;
  if (encoded.length > maxEncodedLength) {
    fail('size_limit', '图片文件不能超过 2MiB', { maxSize: MAX_DECODED_BYTES });
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    fail('invalid_base64', '图片编码不合法');
  }
  if (buffer.length > MAX_DECODED_BYTES) {
    fail('size_limit', '图片文件不能超过 2MiB', { actualSize: buffer.length, maxSize: MAX_DECODED_BYTES });
  }
  return { buffer, declaredMimeType };
}

function sanitizeImageBase64(value, { declaredMimeType = '' } = {}) {
  const decoded = decodeBase64(value);
  const declared = String(declaredMimeType || decoded.declaredMimeType || '').toLowerCase();
  if (declared && declared !== JPEG_MIME && declared !== PNG_MIME) {
    fail('unsupported_type', '只支持 JPEG 或 PNG 图片', { mimeType: declared });
  }

  const sourceInfo = inspectImageBuffer(decoded.buffer);
  if (declared && declared !== sourceInfo.mimeType) {
    fail('invalid_type', '图片类型与声明不一致', { declared, actual: sourceInfo.mimeType });
  }

  let pixels;
  try {
    pixels = sourceInfo.format === 'png'
      ? PNG.sync.read(decoded.buffer)
      : jpeg.decode(decoded.buffer, { useTArray: true, formatAsRGBA: true });
  } catch (err) {
    fail('invalid_image', '图片无法解码', { cause: err.message });
  }
  if (!pixels || pixels.width !== sourceInfo.width || pixels.height !== sourceInfo.height) {
    fail('invalid_image', '图片尺寸无法确认');
  }
  assertDimensions(pixels.width, pixels.height);

  const encoded = jpeg.encode({
    data: pixels.data,
    width: pixels.width,
    height: pixels.height,
  }, JPEG_QUALITY).data;
  if (!encoded || encoded.length === 0) fail('invalid_image', '图片重新编码失败');
  if (encoded.length > MAX_DECODED_BYTES) {
    fail('size_limit', '清洗后的图片不能超过 2MiB', { actualSize: encoded.length, maxSize: MAX_DECODED_BYTES });
  }

  const cleanedInfo = readJpegInfo(encoded);
  if (cleanedInfo.hasExif) fail('metadata', '清洗后的图片仍包含 EXIF');
  return {
    buffer: encoded,
    sourceFormat: sourceInfo.format,
    sourceMimeType: sourceInfo.mimeType,
    mimeType: JPEG_MIME,
    width: cleanedInfo.width,
    height: cleanedInfo.height,
    actualSize: decoded.buffer.length,
    cleanedSize: encoded.length,
    hasExif: false,
  };
}

module.exports = {
  MAX_DECODED_BYTES,
  MAX_WIDTH,
  MAX_HEIGHT,
  MAX_PIXELS,
  JPEG_QUALITY,
  JPEG_MIME,
  PNG_MIME,
  ImageProcessingError,
  inspectImageBuffer,
  sanitizeImageBase64,
};
