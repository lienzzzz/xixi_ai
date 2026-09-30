import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_SCHEMA, SCHEMA_VERSION } from '@xixi/contracts';

test('workspace resolution and native TypeScript type stripping work', () => {
  const schema: string = EVENT_SCHEMA;
  assert.equal(schema, 'xixi.event.v1');
  assert.equal(SCHEMA_VERSION, 1);
});
