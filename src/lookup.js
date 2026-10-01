// 领域对象的查询视图。校验在 rules.js，这里只负责按 id 取用。

function findOrThrow(list, id, label) {
  const hit = list?.find((x) => x.id === id);
  if (!hit) throw new Error(`未知${label}：${id}`);
  return hit;
}

export function attributeById(rules, id) {
  return findOrThrow(rules.attributes, id, '属性');
}

export function commandById(rules, id) {
  return findOrThrow(rules.commands, id, '指令');
}

export function attributeIds(rules) {
  return rules.attributes.map((a) => a.id);
}
