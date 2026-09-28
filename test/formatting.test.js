import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { renderMarkdown } from '../src/platforms/tistory/core.js';
import { repairGeneratedHtml, normalizedTags, styleCodeBlocks } from '../src/shared/formatting.js';

test('code blocks have explicit readable block styles without changing inline code', () => {
  const $ = load(renderMarkdown('`inline`\n\n```plain text\n판매량:  102  108\n추세:    100  110\n```'));
  assert.match($('pre').attr('style'), /overflow-x:auto/);
  assert.match($('pre').attr('style'), /background:#f6f8fa;color:#24292f/);
  assert.match($('pre code').attr('style'), /display:block/);
  // Skins can set an important background on every code element.
  assert.match($('pre code').attr('style'), /background:transparent !important/);
  assert.match($('pre code').attr('style'), /color:inherit !important/);
  assert.equal($('p code').attr('style'), undefined);
  assert.equal($('pre code').text(), '판매량:  102  108\n추세:    100  110\n');
});

test('code styling preserves macros, escaped text and is idempotent', () => {
  const macro = '[##_Image|x?a=1&amp;b=2|CDM|1.3|{}_##]';
  const fixed = styleCodeBlocks('<pre><code>&lt;tag&gt; **text**</code></pre>' + macro);
  assert.ok(fixed.includes(macro));
  assert.equal(load(fixed)('pre code').text(), '<tag> **text**');
  assert.equal(styleCodeBlocks(fixed), fixed);
});

test('Korean particles after punctuation do not break strong emphasis', () => {
  const html = renderMarkdown('**99.9%**를 기록했고 **앞 2층(Prelude)**을 사용합니다. **일반 강조**도 유지합니다.');
  const $ = load(html); assert.equal($('strong').length, 3); assert.ok(!$('body').text().includes('**'));
});
test('code and escaped stars remain literal and inline code remains safe', () => {
  const $ = load(renderMarkdown('`**99.9%**를`\n\n```txt\n**앞 2층(Prelude)**을\n```\n\n\\*\\*문자\\*\\*'));
  assert.equal($('strong').length, 0); assert.match($('code').first().text(), /\*\*/);
});
test('raw and Markdown tables receive borders, padding and header styling', () => {
  for (const source of ['| 평가 | 값 |\n|---|---|\n| A | 99% |', '<table><tr><th>값</th></tr><tr><td>99.9%\\*</td></tr></table>']) {
    const $ = load(renderMarkdown(source)); assert.match($('td').attr('style'), /border:1px/); assert.match($('th').attr('style'), /background-color/); assert.equal($('.tistory-table-scroll').length, 1); assert.ok(!$('td').text().includes('\\*'));
  }
});
test('repair preserves exact Tistory macros and code', () => {
  const macro = '[##_Image|kage@x/img.png?a=1&amp;b=2|CDM|1.3|{}_##]';
  const fixed = repairGeneratedHtml(`<p>**99.9%**를</p><pre>**99.9%**를</pre>${macro}`);
  assert.ok(fixed.includes(macro)); const $ = load(fixed); assert.equal($('strong').length, 1); assert.equal($('pre').text(), '**99.9%**를');
});
test('server tag normalization ignores order and case, not missing tags', () => {
  assert.equal(normalizedTags('CoT,GPT,Astra'), normalizedTags('astra,COT,gpt'));
  assert.notEqual(normalizedTags('CoT,GPT'), normalizedTags('CoT'));
});
