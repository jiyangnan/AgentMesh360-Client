import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_FIELDS = [
  '用户故事',
  '优先级',
  '设计状态',
  '前置条件',
  '输入',
  '交互步骤',
  '预期输出',
  '失败与恢复',
  '验证层',
  '本轮结果',
];

const REQUIRED_DOMAINS = new Set([
  'INSTALL',
  'AUTH',
  'ACCESS',
  'AGENT',
  'CONV',
  'PROVIDER',
  'PACKAGE',
  'HOST',
  'RELEASE',
]);

const PRIORITIES = new Set(['P0', 'P1', 'P2']);
const DESIGN_STATUSES = new Set(['已实现', '部分实现', '计划中', '发布门关闭']);
const EXECUTION_RESULTS = new Set(['待执行', '通过', '失败', '阻断', '不适用']);

function fieldValue(section, label) {
  const match = section.match(new RegExp(`^- \\*\\*${label}\\*\\*：(.+)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

export function validateProductJourneyCases(source, { requireExecuted = false } = {}) {
  const errors = [];
  const headingPattern = /^## (TC-([A-Z]+)-\d{3})：(.+)$/gm;
  const headings = [...source.matchAll(headingPattern)];
  const seen = new Set();
  const domains = new Set();

  if (!source.includes('## 12. 本轮执行记录')) {
    errors.push('缺少“本轮执行记录”章节');
  }

  for (let index = 0; index < headings.length; index += 1) {
    const [heading, id, domain] = headings[index];
    const start = headings[index].index + heading.length;
    const end = headings[index + 1]?.index ?? source.length;
    const section = source.slice(start, end);

    if (seen.has(id)) errors.push(`${id} 重复`);
    seen.add(id);
    domains.add(domain);

    for (const field of REQUIRED_FIELDS) {
      if (!fieldValue(section, field)) errors.push(`${id} 缺少字段：${field}`);
    }

    const priority = fieldValue(section, '优先级');
    if (priority && !PRIORITIES.has(priority)) {
      errors.push(`${id} 优先级无效：${priority}`);
    }

    const designStatus = fieldValue(section, '设计状态');
    if (designStatus && !DESIGN_STATUSES.has(designStatus)) {
      errors.push(`${id} 设计状态无效：${designStatus}`);
    }

    const result = fieldValue(section, '本轮结果');
    if (result && !EXECUTION_RESULTS.has(result)) {
      errors.push(`${id} 本轮结果无效：${result}`);
    } else if (requireExecuted && result === '待执行') {
      errors.push(`${id} 尚未记录本轮执行结果`);
    }
  }

  if (headings.length < 30) {
    errors.push(`核心用户旅程用例不足：${headings.length}，至少需要 30 条`);
  }

  for (const domain of REQUIRED_DOMAINS) {
    if (!domains.has(domain)) errors.push(`缺少测试领域：${domain}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    caseCount: headings.length,
    domains: [...domains].sort(),
  };
}

function main() {
  const input = process.argv.slice(2).find((value) => !value.startsWith('--'))
    ?? 'docs/test-cases/test-cases.md';
  const requireExecuted = process.argv.includes('--require-executed');
  const absolute = path.resolve(process.cwd(), input);
  const result = validateProductJourneyCases(
    fs.readFileSync(absolute, 'utf8'),
    { requireExecuted },
  );
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`ERROR ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `PASS ${result.caseCount} cases across ${result.domains.length} product domains\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
