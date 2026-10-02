import webbrowser

import pytest


@pytest.fixture(autouse=True)
def no_real_browser(monkeypatch):
    """No test may open the user's browser: the confirmation page's tests pass their own `open_browser`."""

    def refuse(url, *args, **kwargs):
        raise AssertionError("a test tried to open a real browser")

    monkeypatch.setattr(webbrowser, "open", refuse)
