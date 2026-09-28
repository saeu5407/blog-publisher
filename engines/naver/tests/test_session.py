import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from naver_blog_mcp import session, editor


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_connects_and_disconnects_without_closing_browser(self):
        with tempfile.TemporaryDirectory() as folder:
            context = MagicMock()
            context.grant_permissions = AsyncMock()
            context.close = AsyncMock()
            runtime = MagicMock()
            browser = MagicMock(contexts=[context])
            browser.close = AsyncMock()
            runtime.chromium.connect_over_cdp = AsyncMock(return_value=browser)
            runtime.stop = AsyncMock()
            factory = MagicMock()
            factory.start = AsyncMock(return_value=runtime)
            with patch.object(session, 'endpoint', return_value='ws://127.0.0.1:1234/devtools/browser/test'), patch.object(session, 'async_playwright', return_value=factory):
                async with session.Session() as result:
                    self.assertIs(result, context)
            runtime.chromium.connect_over_cdp.assert_awaited_once()
            context.close.assert_not_awaited()
            browser.close.assert_not_awaited()
            runtime.stop.assert_awaited_once()

    async def test_login_redirect_stops(self):
        frame = MagicMock()
        frame.url = 'https://nid.naver.com/nidlogin.login'
        page = MagicMock(frames=[frame])
        with self.assertRaisesRegex(ValueError, 'NAVER_AUTH_REQUIRED'):
            await editor.check_auth_barrier(page)

    async def test_security_challenge_stops(self):
        frame = MagicMock()
        frame.url = 'https://blog.naver.com/example'
        frame.get_by_text.return_value.first.is_visible = AsyncMock(return_value=True)
        page = MagicMock(frames=[frame])
        with self.assertRaisesRegex(ValueError, 'NAVER_SECURITY_CHALLENGE'):
            await editor.check_auth_barrier(page)
