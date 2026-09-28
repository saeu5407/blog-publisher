import { hash } from './core.js';

export function flattenCategories(data) {
  if (!Array.isArray(data.categories) || typeof data.rootLabel !== 'string') throw new Error('CATEGORY_SCHEMA_UNSUPPORTED');
  const items = [{ id: 0, name: '카테고리 없음', path: '카테고리 없음', parent_id: null, visibility: 20 }];
  function walk(nodes, names = [], parent = 0) {
    for (const node of nodes) {
      const id = Number(node.id), name = node.name;
      if (!Number.isSafeInteger(id) || id <= 0 || typeof name !== 'string' || !Array.isArray(node.children)) throw new Error('CATEGORY_SCHEMA_UNSUPPORTED');
      items.push({ id, name, path: [...names, name].join(' / '), parent_id: parent, visibility: node.visibility });
      walk(node.children, [...names, name], id);
    }
  }
  walk(data.categories); return items;
}
export function categoryRevision(data) {
  // Post counts may change without any category setting changing.
  return hash({ rootLabel: data.rootLabel, categories: JSON.parse(JSON.stringify(data.categories, (k, v) => k === 'entries' ? undefined : v)) });
}
export function categoryAppend(data, name, parentId = 0) {
  name = name.trim();
  if (!name || name.length > 40 || ['.', '..', 'null'].includes(name) || /[\/\x00-\x1f]/.test(name)) throw new Error('CATEGORY_NAME_INVALID');
  const items = flattenCategories(data);
  if (items.length - 1 >= 500) throw new Error('CATEGORY_LIMIT');
  const parent = items.find(c => c.id === parentId);
  if (!parent) throw new Error('CATEGORY_PARENT_NOT_FOUND');
  if (parentId && parent.parent_id !== 0) throw new Error('CATEGORY_DEPTH_LIMIT: 상위/하위 2단계만 지원합니다.');
  if (items.some(c => c.parent_id === parentId && c.name === name)) throw new Error('CATEGORY_ALREADY_EXISTS');
  const siblings = parentId ? data.categories.find(c => Number(c.id) === parentId).children : data.categories;
  const node = { id: -1, name, children: [], depth: parentId ? 2 : 1, opened: true, priority: siblings.length, visibility: 20, parent: parentId, viewChannel: null, entries: 0, categoryInfo: {}, isNew: true, updatedData: true };
  if (parentId) node.label = `${parent.name}/${name}`;
  // The live UI includes the same new negative-ID node in both arrays.
  return { body: { rootLabel: data.rootLabel, delete: [], append: [node], update: [node] }, path: parentId ? `${parent.path} / ${name}` : name, name, parent_id: parentId };
}
