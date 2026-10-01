// 测试共用的规则夹具：只在这里读一次 data/rules.json。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RULES_URL = new URL('../../data/rules.json', import.meta.url);

export function loadRules() {
  return JSON.parse(readFileSync(fileURLToPath(RULES_URL), 'utf8'));
}
