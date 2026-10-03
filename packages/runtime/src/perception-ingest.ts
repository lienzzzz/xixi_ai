/**
 * Ingest the perception edge's stdout records into the canonical store (V0.3 P0-B, pack
 * `04_RUNTIME_CONSOLIDATION.md` §3).
 *
 * The rule this file implements: **one writer per store.** Before P0-B the console spawned
 * `python -m perception_edge.run --db <file> --append`, so the Python child opened the same SQLite
 * file the console had open and appended `events` + `world_state` rows itself. Two processes wrote
 * one store, the event/projection transaction lived in Python, and the console read presence out of
 * a *different* file than it kept its own history in (§3.5 of the audit).
 *
 * Now the child has no `--db` at all: it prints what it detected and **this** module appends it
 * through `XixiStore.appendPresenceEvent` (validated, one transaction, event + projection). The
 * child keeps owning the detection and its own contract check; the store keeps owning persistence.
 *
 * Only `presence.changed` events are ingested. Frame records carry a JPEG and per-frame numbers —
 * they are measurement, never facts, and raw media must not reach the event log (铁律 6).
 */
import { validateEvent, type EventEnvelope } from '@xixi/contracts';
import type { XixiStore } from '@xixi/domain';

/** What happened to one stdout line. `skipped` is the normal case for frames and summaries. */
export type PerceptionIngestOutcome =
  | { readonly kind: 'ignored'; readonly reason: 'not-json' | 'not-an-event' | 'not-presence' }
  | { readonly kind: 'ingested'; readonly eventType: 'presence.changed'; readonly eventId: string; readonly present: boolean }
  | { readonly kind: 'rejected'; readonly reason: string };

export interface PerceptionIngestDeps {
  /** The canonical store. The ingest is the only writer of presence it needs to know about. */
  readonly store: Pick<XixiStore, 'appendPresenceEvent'>;
  /** Optional audit hook: one line per ingested/rejected record (never called for frames). */
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * Parse one line of the perception edge's NDJSON output and (when it is a presence event) append it.
 *
 * Never throws for a malformed line: a child's bad output must show up as `rejected` (so the page
 * can say what happened) rather than take the console down.
 */
export function ingestPerceptionLine(line: string, deps: PerceptionIngestDeps): PerceptionIngestOutcome {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('{')) return { kind: 'ignored', reason: 'not-json' };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { kind: 'ignored', reason: 'not-json' };
  }

  // The child emits `{"record":"event", …envelope}`, `{"record":"frame",…}` and `{"record":"summary",…}`.
  if (parsed['record'] !== 'event') return { kind: 'ignored', reason: 'not-an-event' };
  if (parsed['event_type'] !== 'presence.changed') return { kind: 'ignored', reason: 'not-presence' };

  // Strip the child's own routing key before validation: the envelope schema is closed and must not
  // grow a `record` field just because the transport wraps it.
  const { record: _record, ...envelope } = parsed;
  void _record;

  try {
    const validated: EventEnvelope = validateEvent(envelope);
    const appended = deps.store.appendPresenceEvent(validated);
    const present = (validated.payload as { present?: unknown }).present === true;
    deps.log?.(`[perception] 在场事件已入库（${validated.event_id}，present=${String(present)}，source=${validated.source}）`);
    // `appended.event` is the domain's `StoredEvent` — the envelope's snake_case `event_id`, not a
    // camelCase `eventId`. The outcome declares `eventId: string`, so reading the wrong key handed
    // every caller `undefined`; the integration test's store double had (wrongly) mirrored the
    // camelCase key, which is why only the type check could see it.
    return { kind: 'ingested', eventType: 'presence.changed', eventId: appended.event.event_id, present };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log?.(`[perception] 丢弃一条在场事件：${reason}`);
    return { kind: 'rejected', reason };
  }
}
