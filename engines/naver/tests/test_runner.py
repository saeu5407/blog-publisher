import unittest
from runner import inspect_markdown, blog_id, owner_from_url, post_url
from naver_blog_mcp.ir import segment


class ParserTests(unittest.TestCase):
    def test_markdown_blocks(self):
        blocks, info = inspect_markdown('## 제목\n\n**굵게**\n\n![사진](images/a.png)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```python\nprint(1)\n```')
        self.assertEqual([b.type for b in blocks], ['heading', 'paragraph', 'image', 'table', 'code'])
        self.assertEqual(info['images'], ['images/a.png'])
        self.assertIn('manual', [s.kind for s in segment(blocks)])

    def test_unsupported_upload_directives(self):
        for directive in [':::file /etc/passwd:::', ':::place 강남역:::', ':::formula x^2:::']:
            with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_DIRECTIVE'):
                inspect_markdown(directive)

    def test_table_clipboard_keeps_cell_borders(self):
        blocks, _ = inspect_markdown('| A | B |\n|---|---|\n| 1 | 2 |')
        markup = ''.join(s.html for s in segment(blocks))
        self.assertIn('border-collapse:collapse', markup)
        self.assertEqual(markup.count('border:1px solid #b7b7b7;padding:8px;'), 4)

    def test_links(self):
        for href in ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test']:
            with self.assertRaisesRegex(ValueError, 'LINK_SCHEME_UNSUPPORTED'):
                inspect_markdown(f'[링크]({href})')
        inspect_markdown('[링크](https://example.com)')

    def test_warning_on_lossy_formats(self):
        _, result = inspect_markdown('> [링크](https://example.com)\n\n`code`')
        self.assertEqual(len(result['warnings']), 2)

    def test_owner_urls(self):
        self.assertEqual(owner_from_url('https://blog.naver.com/example'), 'example')
        self.assertEqual(owner_from_url('https://blog.naver.com/PostList.naver?blogId=example'), 'example')
        self.assertIsNone(owner_from_url('https://evil.example/example'))
        self.assertIsNone(owner_from_url('https://blog.naver.com/MyBlog.naver'))

    def test_post_identity(self):
        self.assertEqual(post_url('https://blog.naver.com/example/123', 'example'), 'https://blog.naver.com/example/123')
        self.assertIsNone(post_url('https://blog.naver.com/other/123', 'example'))
        self.assertIsNone(post_url('https://blog.naver.com/example?Redirect=Write', 'example'))
        with self.assertRaises(ValueError):
            blog_id('../other')


if __name__ == '__main__':
    unittest.main()
