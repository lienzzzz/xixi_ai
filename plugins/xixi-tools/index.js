// 西西最小工具集。M0 只放一个只读、无副作用、无参数的工具，
// 用于证明「文字 → DSH → MiMo → 结构化工具调用 → 回答」这条链路。
// 写入类、外部通信类、高风险类工具按《方案》§27 与铁律 7 一律后置。
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'xixi-tools';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'xixi_get_current_time',
      description: 'Return the current time as an ISO-8601 timestamp. Takes no arguments.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            iso: { type: 'string', required: true, description: 'Current time in ISO-8601 format.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.iso }],
      },
      async execute() {
        return { iso: new Date().toISOString() };
      },
    }),
  );
}
