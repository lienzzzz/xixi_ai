import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFieldPage, explainSilenceReason } from '../../scripts/field-test.ts';
import { silenceReasonLabel } from '../../scripts/serve-chat.ts';

/**
 * t21 (t12 F2): 「她这次为什么没说话」 must be answerable **in the console**, not only in the engine.
 *
 * The engine now tells the two silences apart (`MODEL_SILENCE` vs `ARTIFACT_ONLY_REPLY`); these are the
 * two pages that have to say so — the trial page (`serve-chat`) and the field console (`field-test`) —
 * plus the truncation hint that makes a mid-sentence cut visible.
 */

test('the two silences read differently, in Chinese, on both pages', () => {
  const artifact = explainSilenceReason('ARTIFACT_ONLY_REPLY');
  const chosen = explainSilenceReason('MODEL_SILENCE');
  assert.notEqual(artifact, chosen, 'the two cases must not share one sentence');
  assert.match(artifact, /剔|清洗|不能念/);
  assert.match(chosen, /自己选择|沉默/);
  assert.equal(explainSilenceReason(null), '', 'a spoken turn has no silence reason to print');

  assert.notEqual(silenceReasonLabel('ARTIFACT_ONLY_REPLY'), silenceReasonLabel('MODEL_SILENCE'));
  assert.match(silenceReasonLabel('ARTIFACT_ONLY_REPLY'), /没有可说的|剔除/);
  assert.match(silenceReasonLabel('MODEL_SILENCE'), /模型自己选择/);
  assert.equal(silenceReasonLabel(null), '');
});

test('the console page renders the silence reason, the hygiene summary and the stop reason', () => {
  const page = buildFieldPage({ identityName: '西西', ttsEnabled: false, offline: true } as never);
  assert.match(page, /沉默原因/, 'the right column must print why a turn said nothing');
  assert.match(page, /turn\.silenceReasonText/, 'fed from the turn payload, not recomputed in the page');
  assert.match(page, /清洗：剔除标记/, 'and what the hygiene gate removed');
  assert.match(page, /停止原因/, 'and the provider stop reason');
  assert.match(page, /finishReason === 'length'/, 'with a plain-language note when it was a token cap');
});
