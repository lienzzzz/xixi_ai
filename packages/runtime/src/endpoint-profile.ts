import { openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { validateSchema, type JsonSchema } from '@xixi/contracts';
import type { AmbientDevice } from './ambient-types.ts';

export interface EndpointDevice extends AmbientDevice {
  readonly adapter: 'filtered-events' | 'simulated-playback';
}
export interface EndpointProfile {
  readonly schemaVersion: 1;
  readonly roomId: string;
  readonly devices: readonly EndpointDevice[];
}

const identifier: JsonSchema = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' };
const schema: JsonSchema = { type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'roomId', 'devices'], properties: {
    schemaVersion: { type: 'integer', enum: [1] }, roomId: identifier,
    devices: { type: 'array', minItems: 3, maxItems: 64, items: {
      type: 'object', additionalProperties: false, required: ['id', 'roomId', 'kind', 'adapter'], properties: {
        id: identifier, roomId: identifier, kind: { type: 'string', enum: ['camera', 'microphone', 'speaker'] },
        adapter: { type: 'string', enum: ['filtered-events', 'simulated-playback'] },
      },
    } },
  } };

/** Declarative filtered-event endpoints only; this does not load physical drivers. */
export function parseEndpointProfile(raw: unknown): EndpointProfile {
  if (!validateSchema(schema, raw).ok) throw new Error('INVALID_ENDPOINT_PROFILE');
  const profile = raw as EndpointProfile;
  if (new Set(profile.devices.map((d) => d.id)).size !== profile.devices.length ||
    profile.devices.some((d) => d.roomId !== profile.roomId ||
      d.adapter !== (d.kind === 'speaker' ? 'simulated-playback' : 'filtered-events')) ||
    !['camera', 'microphone', 'speaker'].every((kind) => profile.devices.some((d) => d.kind === kind))) {
    throw new Error('INVALID_ENDPOINT_PROFILE');
  }
  return structuredClone(profile);
}

/** Read at most 64 KiB plus one sentinel byte, even if the file grows after opening. */
export function loadEndpointProfile(path: string): EndpointProfile {
  const limit = 65536;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('INVALID_ENDPOINT_PROFILE');
    if (stat.size > limit) throw new Error('ENDPOINT_PROFILE_TOO_LARGE');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > limit) throw new Error('ENDPOINT_PROFILE_TOO_LARGE');
    return parseEndpointProfile(JSON.parse(buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error instanceof Error && error.message === 'ENDPOINT_PROFILE_TOO_LARGE') throw error;
    // Never echo invalid file contents or provider credentials in parse errors.
    throw new Error('INVALID_ENDPOINT_PROFILE');
  } finally { if (fd !== undefined) closeSync(fd); }
}
