/**
 * Verify the MiMo route through DSH with exactly one real turn.
 *
 * This is the smallest possible "is the brain wired" check: one model call, one
 * tool call, no database. It costs one API request, so it is not part of the
 * offline suite (§51: 真实 API 测试不进每次全量测试).
 *
 * Usage: node scripts/verify-provider-route.ts
 */
import { CliDshTransport } from '@xixi/brain-dsh';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, printEvidence, requireMimoApiKey } from './lib/harness.ts';

const key = requireMimoApiKey();
const transport = new CliDshTransport({
  dshHome: DSH_HOME,
  profile: DSH_PROFILE,
  cwd: REPO_ROOT,
  env: { ...harnessEnv(), MIMO_API_KEY: key },
  timeoutMs: 240_000,
  onDiagnostic: (line) => process.stderr.write(`[dsh] ${line}\n`),
});

const startedAt = Date.now();
const response = await transport.turn(
  {
    kind: 'turn',
    requestId: 'req_verify_provider_001',
    sessionId: 'sess_verify_provider',
    resumeBrainSessionId: null,
    text: '调用 xixi_get_current_time 工具，然后原样报告它返回的时间戳。',
    context: {
      identityName: '西西',
      personality: { talkativeness: 0.45, verbosity: 0.4 },
      timezone: 'Asia/Shanghai',
      workingMemory: [],
    },
  },
  { timeoutMs: 240_000 },
);

printEvidence('MiMo route through DSH (one real turn)', {
  ok: response.ok,
  action: response.action,
  toolName: response.toolName,
  brainSessionId: response.brainSessionId,
  provider: response.provider,
  model: response.model,
  latencyMs: response.latencyMs,
  wallClockMs: Date.now() - startedAt,
  text: response.text,
  error: response.error ?? null,
  diagnostics: transport.lastDiagnostics,
});

const failures: string[] = [];
if (!response.ok) failures.push(`turn failed: ${response.error?.code} ${response.error?.message}`);
if (response.brainSessionId === null) failures.push('harness did not report a session id, restart recovery would be impossible');
if (response.toolName !== 'xixi_get_current_time') failures.push(`expected a xixi_get_current_time tool call, saw ${String(response.toolName)}`);
if (response.text === null || response.text.trim().length === 0) failures.push('harness returned no final text');

if (failures.length > 0) {
  console.error('\nverify:provider FAILED');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('\nverify:provider OK — DSH → MiMo → 工具调用 → 回答 全链路可用');
