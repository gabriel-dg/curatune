"""The confirmation page and its one-time codes. Pure standard library; runs without the `mcp` extra.

The page server is real (127.0.0.1, ephemeral port); requests set `Host` and `Origin` by hand, as a
browser or an attacker's page would.
"""

import http.client
import re
from urllib.parse import urlencode

import pytest

from curatune import plans
from curatune.mcp_server import confirm
from curatune.mcp_server.approval_page import ApprovalPage
from curatune.mcp_server.confirm import ConfirmationError, ConfirmationStore

from .fakes import PLAYLIST_ID, FakeSpotify, track_uri


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def store(clock):
    return ConfirmationStore(clock=clock)


@pytest.fixture
def plan(tmp_path):
    fake = FakeSpotify([track_uri(1), track_uri(2), track_uri(1)])
    built = plans.build_remove_plan(fake, PLAYLIST_ID, [1], plans_dir=tmp_path, reason="Drop the <b>second</b> one.")
    loaded = plans.load_plan(tmp_path / f"{built['plan_id']}.json")
    loaded["changes"]["remove"][0]["name"] = '<script>alert("x")</script> & "Ko-Ko"'  # a hostile track name
    return loaded


def started(store, plan):
    return store.start(plan["plan_id"], plan["checksum"], plan)


def approved(store, plan):
    c = started(store, plan)
    return store.approve(c.token, c.form_nonce)


# --- Codes ------------------------------------------------------------------------------------------


def test_codes_look_like_crockford_base32_and_compare_loosely():
    code = confirm.new_code()
    assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}", code)
    assert confirm.normalize_code(" ab0c-1dEf ") == confirm.normalize_code("AB0C1DEF")
    assert confirm.normalize_code("o1il") == "0111"  # Crockford reads O as 0, I and L as 1


def test_the_right_code_works_once(store, plan):
    c = approved(store, plan)
    assert store.redeem(plan["plan_id"], plan["checksum"], c.code.lower().replace("-", " ")) == "ok"
    with pytest.raises(ConfirmationError) as exc:  # reused
        store.redeem(plan["plan_id"], plan["checksum"], c.code)
    assert exc.value.code == "CONFIRMATION_VOID"


def test_a_wrong_code_uses_an_attempt_and_the_third_voids(store, plan):
    c = approved(store, plan)
    for left in (2, 1):
        with pytest.raises(ConfirmationError) as exc:
            store.redeem(plan["plan_id"], plan["checksum"], "AAAA-AAAA")
        assert exc.value.code == "CONFIRMATION_CODE_INVALID" and exc.value.details["attempts_left"] == left
    with pytest.raises(ConfirmationError) as exc:
        store.redeem(plan["plan_id"], plan["checksum"], "AAAA-AAAA")
    assert exc.value.code == "CONFIRMATION_VOID"
    with pytest.raises(ConfirmationError) as exc:  # the right code is no good any more
        store.redeem(plan["plan_id"], plan["checksum"], c.code)
    assert exc.value.code == "CONFIRMATION_VOID"


def test_codes_before_approval_count_as_wrong(store, plan):
    started(store, plan)
    with pytest.raises(ConfirmationError) as exc:
        store.redeem(plan["plan_id"], plan["checksum"], "AAAA-AAAA")
    assert exc.value.code == "CONFIRMATION_CODE_INVALID"


def test_codes_expire(store, plan, clock):
    c = approved(store, plan)
    clock.now += confirm.CONFIRMATION_TTL_SECONDS
    with pytest.raises(ConfirmationError) as exc:
        store.redeem(plan["plan_id"], plan["checksum"], c.code)
    assert exc.value.code == "CONFIRMATION_EXPIRED"
    assert started(store, plan).token != c.token  # a new call opens a new confirmation


def test_a_code_is_bound_to_its_plan_and_checksum(store, plan):
    c = approved(store, plan)
    for plan_id, checksum in (("20260101T000000Z-remove-other-0000", plan["checksum"]), (plan["plan_id"], "f" * 64)):
        with pytest.raises(ConfirmationError) as exc:
            store.redeem(plan_id, checksum, c.code)
        assert exc.value.code == "CONFIRMATION_NOT_FOUND"
        assert c.code not in str(exc.value.to_dict()) and c.token not in str(exc.value.to_dict())


def test_rejected_stays_rejected_until_it_expires(store, plan, clock):
    c = started(store, plan)
    assert store.reject(c.token, c.form_nonce) is not None
    assert store.redeem(plan["plan_id"], plan["checksum"], "AAAA-AAAA") == "rejected"
    assert started(store, plan) is c  # no new page while the rejection stands
    assert store.approve(c.token, c.form_nonce) is None  # and it can't be approved afterwards
    clock.now += confirm.CONFIRMATION_TTL_SECONDS
    assert started(store, plan) is not c


def test_approving_again_shows_the_same_code(store, plan):
    first = approved(store, plan).code
    c = started(store, plan)
    assert c.state == "approved" and store.approve(c.token, c.form_nonce).code == first


def test_a_wrong_form_nonce_does_nothing(store, plan):
    c = started(store, plan)
    assert store.approve(c.token, "guess") is None and store.reject(c.token, "guess") is None
    assert c.state == "pending" and c.code is None


# --- The page server --------------------------------------------------------------------------------


@pytest.fixture
def page(store):
    p = ApprovalPage(store)
    yield p
    p.close()


def request(page, method, path, *, host=None, origin=None, form=None):
    conn = http.client.HTTPConnection("127.0.0.1", page.port, timeout=5)
    headers = {"Host": host if host is not None else f"127.0.0.1:{page.port}"}
    body = None
    if origin is not None:
        headers["Origin"] = origin
    if form is not None:
        body = urlencode(form)
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    text = resp.read().decode("utf-8")
    conn.close()
    if resp.status == 303:  # after Approve or Reject: back to the page's own address, as a browser follows
        assert resp.getheader("Location") == path.rsplit("/", 1)[0]
        return request(page, "GET", resp.getheader("Location"))
    return resp, text


def path_of(page, c):
    return page.url_for(c).split(str(page.port), 1)[1]


def test_the_page_shows_the_plan_escaped_with_a_strict_csp(page, store, plan):
    c = started(store, plan)
    assert page.url_for(c).startswith("http://127.0.0.1:")
    resp, text = request(page, "GET", path_of(page, c))
    assert resp.status == 200
    csp = resp.getheader("Content-Security-Policy")
    assert "default-src 'none'" in csp and "frame-ancestors 'none'" in csp and "form-action 'self'" in csp
    style_nonce = re.search(r"style-src 'nonce-([^']+)'", csp).group(1)
    assert f'<style nonce="{style_nonce}">' in text and "<script" not in text
    assert "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;Ko-Ko&quot;" in text  # hostile name
    assert "&lt;b&gt;second&lt;/b&gt;" in text and confirm.REASON_LABEL.replace("'", "&#x27;") in text
    assert "Remove 1 of 3 tracks" in text and plan["plan_id"] in text
    assert resp.getheader("Cache-Control") == "no-store" and resp.getheader("X-Frame-Options") == "DENY"
    # "no-referrer" would make browsers send `Origin: null` on Approve, which the Origin check refuses.
    assert resp.getheader("Referrer-Policy") == "same-origin" and "no-referrer" not in text


def test_each_response_has_its_own_style_nonce(page, store, plan):
    c = started(store, plan)
    nonces = {request(page, "GET", path_of(page, c))[0].getheader("Content-Security-Policy") for _ in range(2)}
    assert len(nonces) == 2


@pytest.mark.parametrize("host", ["localhost:{port}", "evil.example", "127.0.0.1", "127.0.0.1:1"])
def test_a_wrong_host_is_refused(page, store, plan, host):
    c = started(store, plan)
    resp, text = request(page, "GET", path_of(page, c), host=host.format(port=page.port))
    assert resp.status == 403 and plan["plan_id"] not in text


def test_unknown_tokens_and_paths_are_not_found(page, store, plan):
    started(store, plan)
    for path in ("/confirm/nope", "/", "/confirm/", "/other"):
        assert request(page, "GET", path)[0].status == 404


def test_approve_needs_the_origin_and_the_form_nonce(page, store, plan):
    c = started(store, plan)
    origin = f"http://127.0.0.1:{page.port}"
    action = path_of(page, c) + "/approve"
    for kwargs in (
        {"origin": None, "form": {"nonce": c.form_nonce}},  # no Origin
        {"origin": "http://evil.example", "form": {"nonce": c.form_nonce}},  # cross-site form
        {"origin": f"http://localhost:{page.port}", "form": {"nonce": c.form_nonce}},
        {"origin": origin, "form": {"nonce": "guess"}},  # forged form
    ):
        resp, text = request(page, "POST", action, **kwargs)
        assert resp.status == 403, kwargs
    assert c.state == "pending" and c.code is None


def test_approve_shows_the_code_and_reject_says_nothing_changes(page, store, plan, tmp_path):
    origin = f"http://127.0.0.1:{page.port}"
    c = started(store, plan)
    resp, text = request(page, "POST", path_of(page, c) + "/approve", origin=origin, form={"nonce": c.form_nonce})
    assert resp.status == 200 and c.state == "approved" and f'<p class="code">{c.code}</p>' in text
    resp, again = request(page, "GET", path_of(page, c))  # reloading shows the same code
    assert c.code in again
    resp, again = request(page, "POST", path_of(page, c) + "/approve", origin=origin, form={"nonce": c.form_nonce})
    assert c.code in again  # and so does approving again

    other = store.start("20260101T000000Z-remove-other-0000", "0" * 64, plan)
    resp, text = request(page, "POST", path_of(page, other) + "/reject", origin=origin, form={"nonce": other.form_nonce})
    assert resp.status == 200 and other.state == "rejected" and "Nothing changes" in text and other.code is None


def test_an_expired_page_says_so(page, store, plan, clock):
    c = started(store, plan)
    clock.now += confirm.CONFIRMATION_TTL_SECONDS
    resp, text = request(page, "GET", path_of(page, c))
    assert resp.status == 200 and "expired" in text and "Approve" not in text
    resp, text = request(
        page, "POST", path_of(page, c) + "/approve", origin=f"http://127.0.0.1:{page.port}", form={"nonce": c.form_nonce}
    )
    assert "expired" in text and c.code is None


def test_requests_are_never_logged(page, store, plan, capfd):
    c = started(store, plan)
    request(page, "GET", path_of(page, c))
    request(page, "GET", "/confirm/nope")
    out, err = capfd.readouterr()
    assert c.token not in out + err and "GET" not in err
