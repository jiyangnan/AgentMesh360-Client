import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateProductJourneyCases } from './validate-product-journey-cases.mjs';

test('the product journey document has complete structured cases and domain coverage', () => {
  const source = fs.readFileSync('docs/test-cases/test-cases.md', 'utf8');
  const result = validateProductJourneyCases(source);

  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.ok(result.caseCount >= 30);
  assert.deepEqual(result.domains, [
    'ACCESS',
    'AGENT',
    'AUTH',
    'CONV',
    'HOST',
    'INSTALL',
    'PACKAGE',
    'PROVIDER',
    'RELEASE',
  ]);
});

test('missing fields, invalid states, and missing product domains fail closed', () => {
  const source = `# Fixture

## 12. 本轮执行记录

## TC-PROVIDER-001：坏用例

- **用户故事**：fixture
- **优先级**：P9
- **设计状态**：猜测
- **本轮结果**：大概通过
`;
  const result = validateProductJourneyCases(source);

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('TC-PROVIDER-001 缺少字段：前置条件'));
  assert.ok(result.errors.includes('TC-PROVIDER-001 优先级无效：P9'));
  assert.ok(result.errors.includes('TC-PROVIDER-001 设计状态无效：猜测'));
  assert.ok(result.errors.includes('TC-PROVIDER-001 本轮结果无效：大概通过'));
  assert.ok(result.errors.includes('缺少测试领域：INSTALL'));
});

test('the final gate refuses cases without an explicit execution result', () => {
  const source = fs.readFileSync('docs/test-cases/test-cases.md', 'utf8');
  const pendingSource = source.replace(
    /(\*\*本轮结果\*\*：)(?:待执行|通过|失败|阻断|不适用)/,
    '$1待执行',
  );
  const pending = validateProductJourneyCases(pendingSource, { requireExecuted: true });
  const completed = validateProductJourneyCases(
    source.replaceAll('**本轮结果**：待执行', '**本轮结果**：通过'),
    { requireExecuted: true },
  );

  assert.equal(pending.ok, false);
  assert.ok(pending.errors.some((error) => error.includes('尚未记录本轮执行结果')));
  assert.equal(completed.ok, true);
});
