/**
 * Small WAV helpers (PCM16 only, which is what every fixture and every MiMo
 * response uses). Shared by the fixture generator, the TTS output writer and the
 * voice loop's segment slicer.
 */
import { readFileSync } from 'node:fs';

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly durationMs: number;
}

/** Walk the chunk list instead of assuming a 44-byte header. */
export function readWavInfo(buffer: Buffer): WavInfo {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataBytes = Math.min(size, buffer.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('WAV has no data chunk');
  const frameBytes = channels * (bitsPerSample / 8);
  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataOffset,
    dataBytes,
    durationMs: (dataBytes / frameBytes / sampleRate) * 1000,
  };
}

/** Cut `[startMs, endMs)` out of a PCM16 WAV, keeping the original format. */
export function sliceWav(buffer: Buffer, startMs: number, endMs: number): Buffer {
  const info = readWavInfo(buffer);
  const frameBytes = info.channels * (info.bitsPerSample / 8);
  const totalFrames = Math.floor(info.dataBytes / frameBytes);
  const startFrame = Math.max(0, Math.min(totalFrames, Math.round((startMs / 1000) * info.sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(totalFrames, Math.round((endMs / 1000) * info.sampleRate)));
  const start = info.dataOffset + startFrame * frameBytes;
  const end = info.dataOffset + endFrame * frameBytes;
  const data = buffer.subarray(start, end);
  const header = Buffer.from(buffer.subarray(0, info.dataOffset));
  header.writeUInt32LE(data.length, 4);
  const dataSizeField = info.dataOffset - 4;
  header.writeUInt32LE(data.length, dataSizeField);
  return Buffer.concat([header, data]);
}

/** Concatenate PCM16 WAVs of identical format (used to stitch a reply per turn). */
export function concatWav(buffers: readonly Buffer[], gapMs = 0): Buffer {
  if (buffers.length === 0) throw new Error('nothing to concatenate');
  const infos = buffers.map((buffer) => readWavInfo(buffer));
  const first = infos[0];
  for (const info of infos) {
    if (info.sampleRate !== first.sampleRate || info.channels !== first.channels || info.bitsPerSample !== first.bitsPerSample) {
      throw new Error('cannot concatenate WAVs with different formats');
    }
  }
  const frameBytes = first.channels * (first.bitsPerSample / 8);
  const gap = Buffer.alloc(Math.round((gapMs / 1000) * first.sampleRate) * frameBytes);
  const parts: Buffer[] = [];
  buffers.forEach((buffer, index) => {
    if (index > 0 && gap.length > 0) parts.push(gap);
    const info = infos[index];
    parts.push(buffer.subarray(info.dataOffset, info.dataOffset + info.dataBytes));
  });
  const data = Buffer.concat(parts);
  const header = Buffer.from(buffers[0].subarray(0, first.dataOffset));
  header.writeUInt32LE(data.length, 4);
  header.writeUInt32LE(data.length, first.dataOffset - 4);
  return Buffer.concat([header, data]);
}

export function readWav(path: string): Buffer {
  return readFileSync(path);
}
