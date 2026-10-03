/**
 * 文档一致性检查（防止文档腐烂）。
 *
 * 检查三件事，全部是「文档说了不存在的东西」这类错误：
 *   1. markdown 相对链接能否解析到真实文件/目录；
 *   2. 反引号里写出的仓库路径（packages/…、scripts/… 等）是否真的存在；
 *   3. `docs/**` 里的文档是否带「最后更新」标记（面向接手者的新鲜度要求）。
 *
 * 退出码非 0 即表示文档已与代码脱节——这正是接手者最容易被误导的地方。
 *
 * 用法：node scripts/check-docs.ts [--quiet]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { REPO_ROOT } from './lib/harness.ts';

const quiet = process.argv.includes('--quiet');

/** 需要检查的 markdown：仓库根的两份 + docs 下全部。 */
function markdownFiles(): string[] {
  const files = [join(REPO_ROOT, 'README.md'), join(REPO_ROOT, 'AGENTS.md')];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  };
  walk(join(REPO_ROOT, 'docs'));
  return files;
}

interface Problem {
  readonly file: string;
  readonly line: number;
  readonly kind: 'link' | 'path' | 'freshness';
  readonly detail: string;
}

/**
 * 故意不存在的路径白名单：文档里**说明它们不存在**是正确写法。
 * 例如 `infra/docker-compose.yml` 是方案 §24 的规划，本机没有 Docker，所以刻意不落地。
 */
const INTENTIONALLY_ABSENT = new Set(['infra/docker-compose.yml', 'infra/mosquitto/mosquitto.conf']);

/**
 * 只有「活文档」要求新鲜度标记；`docs/adr/` 与 `docs/recon/` 是带日期的历史记录
 * （文件名即日期），不需要额外维护标记。
 */
function needsFreshnessMarker(relativePath: string): boolean {
  return relativePath.startsWith('docs/') && !relativePath.startsWith('docs/adr/') && !relativePath.startsWith('docs/recon/');
}

const problems: Problem[] = [];
const rel = (path: string): string => relative(REPO_ROOT, path).replace(/\\/g, '/');

/** 反引号里出现的、看起来像仓库路径的字符串。 */
const REPO_PATH = /`((?:packages|apps|scripts|services|plugins|tests|config|docs|infra)\/[\w./@-]+\.(?:ts|js|mjs|py|json|sql|md|yml|yaml))`/g;
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

for (const file of markdownFiles()) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  // 1) 相对链接
  lines.forEach((line, index) => {
    for (const match of line.matchAll(LINK)) {
      const target = match[1];
      if (target === undefined) continue;
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (clean === undefined || clean.length === 0) continue;
      const resolved = resolve(dirname(file), decodeURI(clean));
      if (!existsSync(resolved)) {
        problems.push({ file: rel(file), line: index + 1, kind: 'link', detail: `链接指向不存在的路径：${target}` });
      }
    }
  });

  // 2) 反引号里的仓库路径
  lines.forEach((line, index) => {
    for (const match of line.matchAll(REPO_PATH)) {
      const target = match[1];
      if (target === undefined) continue;
      // 目录式引用（以 / 结尾）或通配符不检查
      if (target.endsWith('/') || target.includes('*')) continue;
      if (INTENTIONALLY_ABSENT.has(target)) continue;
      if (!existsSync(join(REPO_ROOT, target))) {
        problems.push({ file: rel(file), line: index + 1, kind: 'path', detail: `引用了不存在的文件：${target}` });
      }
    }
  });

  // 3) 新鲜度标记（只要求 docs/ 下的活文档）
  if (needsFreshnessMarker(rel(file))) {
    if (!/最后更新/.test(text)) {
      problems.push({ file: rel(file), line: 1, kind: 'freshness', detail: '缺少「最后更新」标记（接手者无法判断文档新旧）' });
    }
  }
}

const byKind = {
  link: problems.filter((problem) => problem.kind === 'link'),
  path: problems.filter((problem) => problem.kind === 'path'),
  freshness: problems.filter((problem) => problem.kind === 'freshness'),
};

if (!quiet) {
  console.log(`检查了 ${markdownFiles().length} 份 markdown`);
  console.log(`  失效链接 ${byKind.link.length}｜不存在的文件引用 ${byKind.path.length}｜缺少新鲜度标记 ${byKind.freshness.length}`);
  for (const problem of problems) {
    console.log(`  [${problem.kind}] ${problem.file}:${problem.line} — ${problem.detail}`);
  }
}

if (problems.length > 0) {
  console.error(`\ncheck:docs FAILED（${problems.length} 个问题）：文档里有不存在的东西，或者缺少更新标记。`);
  process.exit(1);
}
console.log('\ncheck:docs OK：链接、文件引用与新鲜度标记都一致');
