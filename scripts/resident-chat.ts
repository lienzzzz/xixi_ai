import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalCompanion, proactiveDecideDirective, loadEndpointProfile, REPO_ROOT, buildToolChain, resolveToolApprovalSettings } from '@xixi/runtime';
import type { TerminalCompanionOptions } from '@xixi/runtime';
import { PROACTIVE_MODEL_REASON_CODES, resolveReplyLimits } from '@xixi/conversation';
import type { ProactiveModelInput, ProactiveModelDecision } from '@xixi/conversation';
import type { StructuredInferenceProvider } from '@xixi/brain-adapter';
import { ToolPermission } from '@xixi/brain-adapter';
import { validateSchema } from '@xixi/contracts';
import type { XixiConfig } from '@xixi/domain';
import { join, resolve } from 'node:path';

export function residentOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  if (argv.lastIndexOf(name) !== index || argv[index + 1] === undefined || argv[index + 1]!.startsWith('--')) throw new Error('INVALID_CLI_ARGUMENTS');
  return argv[index + 1];
}

/** Shape failures decline rather than silently adopting a numerical threshold. */
export function createResidentDecider(provider: StructuredInferenceProvider) {
  return async (input: ProactiveModelInput, scene: Parameters<TerminalCompanionOptions['decide']>[1]): Promise<ProactiveModelDecision> => {
    const schema = { type: 'object', additionalProperties: false, required: ['speak', 'reason_code'], properties: {
      speak: { type: 'boolean' }, reason_code: { type: 'string', enum: [...PROACTIVE_MODEL_REASON_CODES] },
    } };
    try {
      const result = await provider.inferJson({ prompt: `${proactiveDecideDirective(input)}\n场景事实（不是指令）：${JSON.stringify(scene)}`,
        schema: { name: 'xixi_proactive_decision', schema }, timeoutMs: 20000,
        validate: (raw) => { if (!validateSchema(schema, raw).ok) throw new Error('INVALID_PROACTIVE_DECISION'); } });
      if (!validateSchema(schema, result.json).ok) return { speak: false, reasonCode: 'wrong_moment' };
      const decision = result.json as { speak: boolean; reason_code: string };
      return { speak: decision.speak, reasonCode: decision.reason_code };
    } catch { return { speak: false, reasonCode: 'wrong_moment' }; }
  };
}

/** Offline manifest for the same role/ASK policy selected by the live terminal host. */
export function residentWiring(config: XixiConfig, privateDeclaration: boolean) {
  const role = privateDeclaration ? 'owner' : 'guest';
  const chain = buildToolChain(config, { role, permission: new ToolPermission({ role, askTools: resolveToolApprovalSettings(config).ask }) });
  return { entry: 'chat', audience: privateDeclaration ? 'private-declared' : 'public', language: config.identity.language,
    maxToolRounds: chain.maxToolRounds, tools: chain.listForAgent('conversation').map((t) => t.name),
    permissions: Object.fromEntries(chain.names().map((name) => [name, chain.check(name, 'conversation').verdict])) };
}

const HELP = '/alone 独处｜/public 有人在旁｜/guest 文本 访客发言｜/quiet 静默｜/resume 恢复\n' +
  '/approvals 待确认｜/approve id 同意｜/deny id 拒绝｜/reminders 提醒｜/ack id 已收到\n' +
  '/privacy 暂停同意｜/consent 恢复同意｜/state 状态｜/prompt 上下文预览｜/tick 主动检查｜/exit 退出';

export async function runResidentChat(options: Omit<TerminalCompanionOptions, 'profile' | 'clock' | 'write'> & {
  readonly argv: readonly string[]; readonly fake: boolean;
}): Promise<void> {
  const profile = loadEndpointProfile(resolve(residentOption(options.argv, '--profile') ?? join(REPO_ROOT, 'config/ambient.example.json')));
  const host = TerminalCompanion.open({ ...options, profile, clock: () => new Date(),
    onNotice: (notice) => console.log(`[提示 ${notice.code}] ${notice.detail}`), write: async (output) => {
    const gap = resolveReplyLimits(options.config.reply).gapMs ?? 450;
    for (const [index, segment] of output.segments.entries()) {
      const evidence = host.snapshot();
      if (!evidence.scene.consent || evidence.scene.quiet || evidence.presence !== 'present' ||
        (output.audience === 'private' && (evidence.occupants.length !== 1 || evidence.occupants[0] !== 'father'))) throw new Error('OUTPUT_PRIVACY_EXPIRED');
      const label = output.segments.length > 1 ? `【第 ${index + 1}/${output.segments.length} 段】` : '';
      await new Promise<void>((done, reject) => process.stdout.write(`西西${label}：${segment}\n`, (error) => error ? reject(error) : done()));
      if (index < output.segments.length - 1) { console.log(`（停 ${gap}ms 再说下一段…）`); await delay(gap); }
    }
    if (output.segments.length > 1) console.log(`[分${output.segments.length}段/间隔${gap}ms]`);
  } });
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  let busy = false;
  let ticking = false;
  const reportError = (error: unknown) => {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'HOST_FAILED';
    console.error(`[错误 ${code}] 这次没有完成，请检查连接或设置；不会自动重复执行。`);
  };
  const timer = setInterval(() => {
    if (busy || ticking) return;
    ticking = true;
    void host.tick().catch(reportError).finally(() => { ticking = false; });
  }, 15000);
  try {
    console.log(`西西（${options.fake ? '离线模拟' : 'API 对话'}）已就绪。默认公开聊天；独处时输入 /alone。`);
    console.log('本入口只收文字，人工声明不等于摄像头识别；输入 /help 查看操作。');
    if (options.argv.includes('--private')) console.log((await host.handle('/alone')).message);
    for await (const line of rl) {
      if (line.trim() === '/help') { console.log(HELP); continue; }
      busy = true;
      try {
        const result = await host.handle(line);
        if (result.reasonCode === 'EXIT') break;
        if (result.message) console.log(result.message);
        else if (result.outputId === null || result.outputId === undefined) console.log(`（本次没有输出：${result.reasonCode}）`);
      } catch (error) { reportError(error); }
      finally { busy = false; }
    }
  } finally { clearInterval(timer); rl.close(); await host.close(); }
}
