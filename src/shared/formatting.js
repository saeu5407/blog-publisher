import { Marked } from 'marked';
import { load } from 'cheerio';

export const markdownParser = new Marked({ gfm: true }, { extensions: [{
  name: 'koreanStrong', level: 'inline',
  start(src) { return src.indexOf('**'); },
  tokenizer(src) {
    // CommonMark treats punctuation before the closing delimiter + Korean
    // particles as an intraword delimiter. Notion exports expect emphasis here.
    const match = /^\*\*((?:(?!\*\*)[^\n])+?[^\p{L}\p{N}\s])\*\*(?=[가-힣])/u.exec(src);
    if (match && !/^\s/.test(match[1])) return { type: 'koreanStrong', raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
  },
  renderer(token) { return `<strong>${this.parser.parseInline(token.tokens)}</strong>`; },
}] });

export function styleTables(html) {
  const $ = load(html, null, false);
  $('table').each((_, el) => {
    const table = $(el);
    table.attr('style', 'width:100%;border-collapse:collapse;border:1px solid #cbd5e1;margin:20px 0;font-size:0.95em;line-height:1.6;');
    table.attr('data-ke-style', 'style12');
    table.find('th,td').each((i, cell) => {
      const header = cell.tagName === 'th';
      $(cell).attr('style', `border:1px solid #cbd5e1;padding:12px 14px;text-align:left;vertical-align:top;overflow-wrap:anywhere;${header ? 'background-color:#f1f5f9;color:#1e293b;font-weight:700;' : ''}`);
      $(cell).contents().each((j, node) => { if (node.type === 'text') node.data = node.data.replace(/\\\*/g, '*'); });
    });
    if (!table.parent().hasClass('tistory-table-scroll')) table.wrap('<div class="tistory-table-scroll" style="max-width:100%;overflow-x:auto;"></div>');
  });
  return $.html();
}

export function styleCodeBlocks(html) {
  // Preserve attachment macros byte-for-byte when repairing published HTML.
  const macros = [];
  const protectedHtml = html.replace(/\[##_[\s\S]*?_##\]/g, raw => {
    const key = `MCPCODEMACRO${macros.length}TOKEN`; macros.push([key, raw]); return key;
  });
  const $ = load(protectedHtml, null, false);
  $('pre').each((_, el) => {
    $(el).attr('style', 'display:block;box-sizing:border-box;max-width:100%;margin:24px 0;padding:18px 20px;overflow-x:auto;background:#f6f8fa;color:#24292f;border:1px solid #d0d7de;border-radius:8px;white-space:pre;font:14px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;text-align:left;');
    $(el).find('code').attr('style', 'display:block;width:auto;margin:0;padding:0;background:transparent !important;color:inherit !important;border:0;border-radius:0;box-shadow:none;font:inherit;white-space:inherit;word-break:normal;overflow-wrap:normal;');
  });
  let result = $.html();
  for (const [key, raw] of macros) result = result.replaceAll(key, raw);
  return result;
}

// Repair generated HTML without reuploading attachments or touching code.
export function repairGeneratedHtml(html) {
  const macros = [];
  const protectedHtml = html.replace(/\[##_[\s\S]*?_##\]/g, raw => { const key = `MCPKEEPMACRO${macros.length}TOKEN`; macros.push([key, raw]); return key; });
  const $ = load(protectedHtml, null, false);
  const nodes = [];
  function walk(node) {
    if (['pre', 'code', 'script', 'style'].includes(node.tagName)) return;
    if (node.type === 'text' && node.data.includes('**')) nodes.push(node);
    for (const child of node.children || []) walk(child);
  }
  walk($.root()[0]);
  for (const node of nodes) {
    const text = node.data.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    $(node).replaceWith(markdownParser.parseInline(text));
  }
  let result = styleTables($.html());
  for (const [key, raw] of macros) result = result.replaceAll(key, raw);
  return result;
}

export function normalizedTags(tags) { return [...new Set(tags.split(',').map(t => t.trim().toLocaleLowerCase()).filter(Boolean))].sort().join(','); }
