"""Attach to the running dedicated browser; disconnect without closing it."""
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright

def endpoint():
    value = os.getenv("NAVER_CDP", "")
    parsed = urlparse(value)
    if parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or not parsed.port or not parsed.path.startswith("/devtools/browser/") or parsed.username or parsed.password:
        raise ValueError("NAVER_BROWSER_NOT_CONNECTED")
    return value


class Session:
    def __init__(self, headless=None):
        self.headless = headless if headless is not None else os.getenv("HEADLESS", "false") == "true"
        self._pw = None
        self.ctx = None

    async def __aenter__(self):
        address = endpoint()
        self._pw = await async_playwright().start()
        try:
            browser = await self._pw.chromium.connect_over_cdp(address, timeout=5000)
            if not browser.contexts:
                raise ValueError("NAVER_BROWSER_CONTEXT_MISSING")
            self.ctx = browser.contexts[0]
            await self.ctx.grant_permissions(
                ["clipboard-read", "clipboard-write"], origin="https://blog.naver.com"
            )
            return self.ctx
        except BaseException:
            await self.__aexit__(None, None, None)
            raise

    async def __aexit__(self, *exc):
        self.ctx = None
        if self._pw:
            await self._pw.stop()
            self._pw = None
