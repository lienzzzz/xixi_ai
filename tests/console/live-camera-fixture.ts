/**
 * The fake camera child the console tests drive (extracted in t103 so three test files share one
 * implementation instead of three copies): no camera, no Python, and every line the child would
 * print can be pushed by hand.
 */
import type { LiveCameraHandle, LiveCameraRunner } from '../../scripts/field-test.ts';

export interface FakeLiveChild {
  readonly runner: LiveCameraRunner;
  /** Feed one stdout line (a `frame` record, an `event`, …). */
  push: (line: string) => void;
  /** Feed one stderr line — the child's own complaints land here. */
  pushError: (line: string) => void;
  /** Report the process exiting. */
  exit: (code: number | null) => void;
  readonly kills: number;
  readonly started: { source: string; cameraIndex: number; dbPath: string }[];
}

export function fakeLiveRunner(): FakeLiveChild {
  const started: { source: string; cameraIndex: number; dbPath: string }[] = [];
  let onLine: ((line: string) => void) | null = null;
  let onExit: ((code: number | null) => void) | null = null;
  let killCount = 0;
  return {
    started,
    get kills() {
      return killCount;
    },
    push: (line) => onLine?.(line),
    pushError: (line) => onLine?.(line),
    exit: (code) => onExit?.(code),
    runner: {
      start(options) {
        started.push({ source: options.source, cameraIndex: options.cameraIndex, dbPath: options.presenceDbPath });
        onLine = options.onLine;
        onExit = options.onExit;
        const handle: LiveCameraHandle = {
          pid: 7000 + started.length,
          kill: () => {
            killCount += 1;
          },
          write: () => {},
        };
        return handle;
      },
    },
  };
}

/** One frame record, as `perception_edge.run --live` prints it (with or without a picture). */
export function frameLine(options: { readonly width: number; readonly height: number; readonly bytes: number; readonly jpeg?: string | null; readonly index?: number; readonly present?: boolean }): string {
  return JSON.stringify({
    type: 'frame',
    at: '2026-09-30T16:20:00.000+08:00',
    frame_index: options.index ?? 3,
    present: options.present ?? true,
    state: 'present',
    confidence: 0.9,
    changed: false,
    motion_ratio: 0.01,
    faces: 1,
    detect_ms: 7,
    jpeg_bytes: options.bytes,
    width: options.width,
    height: options.height,
    jpeg: options.jpeg === undefined ? 'ZmFrZS1qcGVnLWJ5dGVz' : options.jpeg,
  });
}

/** The exact sentence the perception edge prints when it cannot open the camera. */
export const CAMERA_UNAVAILABLE_LINE = '摄像头不可用：camera index 0: cannot open (DSHOW)';
