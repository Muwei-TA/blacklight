import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const {
  ImageProcessingError,
  MAX_DECODED_BYTES,
  inspectImageBuffer,
  sanitizeImageBase64,
} = require('../shared/image-processing');

function rgba(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 0x31;
    data[offset + 1] = 0x72;
    data[offset + 2] = 0xa8;
    data[offset + 3] = 0xff;
  }
  return { data, width, height };
}

function makeJpeg(width = 3, height = 2) {
  return jpeg.encode(rgba(width, height), 90).data;
}

function makePng(width = 3, height = 2) {
  return PNG.sync.write(rgba(width, height));
}

function withExif(jpegBuffer) {
  const payload = Buffer.from('Exif\0\0\x01\x02\x03\x04', 'binary');
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([jpegBuffer.subarray(0, 2), segment, jpegBuffer.subarray(2)]);
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ImageProcessingError && error.code === code);
}

test('JPEG with EXIF is decoded and re-encoded without metadata', () => {
  const source = withExif(makeJpeg());
  const sourceInfo = inspectImageBuffer(source);
  assert.equal(sourceInfo.mimeType, 'image/jpeg');
  assert.equal(sourceInfo.hasExif, true);

  const cleaned = sanitizeImageBase64(source.toString('base64'), { declaredMimeType: 'image/jpeg' });
  assert.equal(cleaned.mimeType, 'image/jpeg');
  assert.equal(cleaned.sourceMimeType, 'image/jpeg');
  assert.equal(cleaned.hasExif, false);
  assert.equal(inspectImageBuffer(cleaned.buffer).hasExif, false);
  assert.equal(cleaned.width, 3);
  assert.equal(cleaned.height, 2);
});

test('PNG input is validated and stored as a clean JPEG', () => {
  const source = makePng(4, 3);
  const cleaned = sanitizeImageBase64(`data:image/png;base64,${source.toString('base64')}`);
  assert.equal(cleaned.sourceMimeType, 'image/png');
  assert.equal(cleaned.mimeType, 'image/jpeg');
  assert.equal(cleaned.width, 4);
  assert.equal(cleaned.height, 3);
  assert.equal(inspectImageBuffer(cleaned.buffer).mimeType, 'image/jpeg');
});

test('magic bytes and declared MIME must agree', () => {
  const jpegBuffer = makeJpeg();
  expectCode(() => sanitizeImageBase64(Buffer.from('not an image').toString('base64')), 'unsupported_type');
  expectCode(
    () => sanitizeImageBase64(jpegBuffer.toString('base64'), { declaredMimeType: 'image/png' }),
    'invalid_type',
  );
  expectCode(
    () => sanitizeImageBase64(`data:image/gif;base64,${jpegBuffer.toString('base64')}`),
    'unsupported_type',
  );
});

test('pixel dimensions are rejected before decoder allocation', () => {
  const header = Buffer.alloc(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(4097, 16);
  header.writeUInt32BE(1, 20);
  expectCode(() => sanitizeImageBase64(header.toString('base64')), 'pixel_limit');
});

test('decoded input and cleaned output stay within the 2 MiB limit', () => {
  const oversized = Buffer.alloc(MAX_DECODED_BYTES + 1, 0x41);
  expectCode(() => sanitizeImageBase64(oversized.toString('base64')), 'size_limit');
});
