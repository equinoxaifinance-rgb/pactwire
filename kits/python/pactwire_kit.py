"""Pactwire agent kit for Python.

Gives a Python agent everything the JavaScript kit (src/agent-kit.mjs) gives a
Node agent, byte for byte compatible with the Pactwire protocol (SPEC.md):

  - canonical(value)            canonical JSON, identical bytes to src/crypto.mjs
  - Identity                    an Ed25519 key published in the A2A agent card
  - sign / verify               signed objects { payload, signer, sig }
  - make_offer / action_for     signed terms and signed deal actions
  - PactwireClient             the REST API (urllib, no dependencies)
  - PactwireAgent              an A2A 1.0 agent server (HTTP+JSON and JSON-RPC)
                                that answers Pactwire ping / offer / job / verify
  - verify_chain                offline check of the public receipt log

Requires Python 3.9+ and the `cryptography` package. Nothing else.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import inspect
import ipaddress
import json
import math
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

__all__ = [
    'IDENTITY_EXT', 'TERMS_VERSION', 'GENESIS', 'A2A_PROTOCOL_VERSION',
    'canonical', 'sha256_hex', 'hash_json', 'b64url', 'from_b64url',
    'Identity', 'generate_key_pair', 'key_id', 'sign', 'verify',
    'identity_extension', 'build_agent_card', 'make_offer', 'action_for', 'in_minutes', 'iso_now',
    'PactwireClient', 'PactwireAPIError', 'PactwireAgent', 'SellerAgent', 'send_a2a',
    'verify_chain', 'verify_receipt',
]

IDENTITY_EXT = 'urn:pactwire:identity:1'
TERMS_VERSION = 'pactwire/1'
GENESIS = '0' * 64
A2A_PROTOCOL_VERSION = '1.0'
A2A_MEDIA_TYPE = 'application/a2a+json'
SUPPORTED_A2A_VERSIONS = ('1.0', '1.0.0', '1.0.1')
MAX_A2A_BYTES = 64 * 1024
_MAX_SAFE_INT = 2 ** 53

# ---------------------------------------------------------------------------
# Canonical JSON (must produce exactly the bytes JavaScript's canonical() does)
# ---------------------------------------------------------------------------

_ESCAPES = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t'}


def _js_string(s: str) -> str:
    """JSON.stringify for a string: short escapes, other C0 controls and lone
    surrogates as lowercase \\uXXXX, everything else (non-ASCII, U+2028, DEL) as is."""
    out = ['"']
    for ch in s:
        e = _ESCAPES.get(ch)
        if e is not None:
            out.append(e)
            continue
        cp = ord(ch)
        if cp < 0x20 or 0xD800 <= cp <= 0xDFFF:
            out.append('\\u%04x' % cp)
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


def _js_number(x: Any) -> str:
    """Number.prototype.toString / JSON.stringify for a finite number."""
    if isinstance(x, int):
        if -_MAX_SAFE_INT <= x <= _MAX_SAFE_INT:
            return str(x)
        # JavaScript holds every number as a double: a larger integer arrives
        # at the other side rounded, so sign what the other side will see.
        try:
            x = float(x)
        except OverflowError:
            raise ValueError('non-finite number cannot be signed') from None
    if not math.isfinite(x):
        raise ValueError('non-finite number cannot be signed')
    if x == 0:
        return '0'  # also -0
    sign_, digits, exp = Decimal(repr(x)).as_tuple()  # repr = shortest round-trip, like JS
    digits = list(digits)
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exp += 1
    ds = ''.join(map(str, digits))
    k = len(ds)
    n = exp + k  # value = 0.ds * 10^n
    if k <= n <= 21:
        body = ds + '0' * (n - k)
    elif 0 < n <= 21:
        body = ds[:n] + '.' + ds[n:]
    elif -6 < n <= 0:
        body = '0.' + '0' * (-n) + ds
    else:
        e = n - 1
        mant = ds[0] + ('.' + ds[1:] if k > 1 else '')
        body = mant + 'e' + ('+' if e >= 0 else '-') + str(abs(e))
    return ('-' if sign_ else '') + body


def _utf16_key(s: str) -> bytes:
    # Big-endian UTF-16 bytes compare exactly like JavaScript's code-unit sort.
    return s.encode('utf-16-be', 'surrogatepass')


def canonical(value: Any) -> str:
    """Canonical JSON: sorted keys (UTF-16 code units), no whitespace, JSON.stringify scalars.
    Python None is JSON null. Tuples are arrays. NaN / Infinity raise ValueError."""
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(canonical(v) for v in value) + ']'
    if isinstance(value, dict):
        for k in value:
            if not isinstance(k, str):
                raise TypeError(f'object keys must be strings, got {type(k).__name__}')
        keys = sorted(value.keys(), key=_utf16_key)
        return '{' + ','.join(_js_string(k) + ':' + canonical(value[k]) for k in keys) + '}'
    raise TypeError(f'{type(value).__name__} cannot be signed')


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def from_b64url(text: str) -> bytes:
    s = str(text)
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def sha256_hex(data: Any) -> str:
    return hashlib.sha256(data.encode('utf-8', 'surrogatepass') if isinstance(data, str) else data).hexdigest()


def hash_json(value: Any) -> str:
    return sha256_hex(canonical(value))


def _utf8(s: str) -> bytes:
    # 'surrogatepass' only matters for lone surrogates, which canonical() escapes anyway.
    return s.encode('utf-8', 'surrogatepass')


def iso_now() -> str:
    return _iso(datetime.now(timezone.utc))


def _iso(dt: datetime) -> str:
    """Same shape as JavaScript's Date.toISOString(): 2026-10-08T12:00:00.000Z."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (dt.microsecond // 1000)


def in_minutes(minutes: float) -> str:
    return _iso(datetime.now(timezone.utc) + timedelta(minutes=minutes))


# ---------------------------------------------------------------------------
# Keys and signatures
# ---------------------------------------------------------------------------

def generate_key_pair() -> dict:
    key = Ed25519PrivateKey.generate()
    x = b64url(key.public_key().public_bytes_raw())
    d = b64url(key.private_bytes_raw())
    return {'privateJwk': {'kty': 'OKP', 'crv': 'Ed25519', 'x': x, 'd': d},
            'publicJwk': {'kty': 'OKP', 'crv': 'Ed25519', 'x': x}}


def key_id(public_jwk: dict) -> str:
    """RFC 7638 JWK thumbprint for an OKP key."""
    return b64url(hashlib.sha256(_utf8(canonical({'crv': public_jwk['crv'], 'kty': public_jwk['kty'], 'x': public_jwk['x']}))).digest())


def _private_key(jwk: dict) -> Ed25519PrivateKey:
    if not isinstance(jwk, dict) or jwk.get('kty') != 'OKP' or jwk.get('crv') != 'Ed25519' or not jwk.get('d') or not jwk.get('x'):
        raise ValueError('private key must be an Ed25519 JWK')
    key = Ed25519PrivateKey.from_private_bytes(from_b64url(jwk['d']))
    if b64url(key.public_key().public_bytes_raw()) != jwk['x']:
        raise ValueError('private JWK: d does not match x')
    return key


def _public_key(jwk: dict) -> Ed25519PublicKey:
    if not isinstance(jwk, dict) or jwk.get('kty') != 'OKP' or jwk.get('crv') != 'Ed25519' or not isinstance(jwk.get('x'), str):
        raise ValueError('public key must be an Ed25519 JWK')
    return Ed25519PublicKey.from_public_bytes(from_b64url(jwk['x']))


class Identity:
    """An agent's identity: its origin and Ed25519 key pair."""

    def __init__(self, origin: Optional[str], private_jwk: dict, public_jwk: Optional[dict] = None):
        self._key = _private_key(private_jwk)
        self.origin = origin.rstrip('/') if origin else origin
        self.private_jwk = {'kty': 'OKP', 'crv': 'Ed25519', 'x': private_jwk['x'], 'd': private_jwk['d']}
        self.public_jwk = {'kty': 'OKP', 'crv': 'Ed25519', 'x': private_jwk['x']}
        if public_jwk and public_jwk.get('x') != self.public_jwk['x']:
            raise ValueError('public JWK does not match the private JWK')
        self.kid = key_id(self.public_jwk)

    @classmethod
    def generate(cls, origin: Optional[str] = None) -> 'Identity':
        return cls(origin, generate_key_pair()['privateJwk'])

    @classmethod
    def from_dict(cls, data: dict, origin: Optional[str] = None) -> 'Identity':
        return cls(origin or data.get('origin'), data['privateJwk'], data.get('publicJwk'))

    @classmethod
    def load(cls, path: str, origin: Optional[str] = None) -> 'Identity':
        with open(path, 'r', encoding='utf-8') as f:
            return cls.from_dict(json.load(f), origin)

    @classmethod
    def load_or_create(cls, path: str, origin: Optional[str] = None) -> 'Identity':
        if os.path.exists(path):
            return cls.load(path, origin)
        ident = cls.generate(origin)
        ident.save(path)
        return ident

    def to_dict(self) -> dict:
        return {'origin': self.origin, 'privateJwk': dict(self.private_jwk), 'publicJwk': dict(self.public_jwk), 'kid': self.kid}

    def save(self, path: str) -> None:
        """Write the identity (including the private key) to a file readable only by its owner."""
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(self.to_dict(), f, indent=2)

    def sign(self, payload: Any) -> dict:
        if not self.origin:
            raise ValueError('identity has no origin yet')
        return {'payload': payload, 'signer': self.origin, 'sig': b64url(self._key.sign(_utf8(canonical(payload))))}

    def __repr__(self) -> str:
        return f'Identity(origin={self.origin!r}, kid={self.kid!r})'


def sign(payload: Any, signer: Any, private_jwk: Optional[dict] = None) -> dict:
    """sign(payload, identity) or sign(payload, signer_id, private_jwk) -> { payload, signer, sig }."""
    if isinstance(signer, Identity):
        return signer.sign(payload)
    if private_jwk is None:
        raise ValueError('pass an Identity, or a signer id plus its private JWK')
    sig = _private_key(private_jwk).sign(_utf8(canonical(payload)))
    return {'payload': payload, 'signer': signer, 'sig': b64url(sig)}


def verify(signed: Any, public_jwk: dict) -> bool:
    """True only if signed['sig'] is a valid Ed25519 signature over canonical(signed['payload'])."""
    if not isinstance(signed, dict) or not isinstance(signed.get('sig'), str) or 'payload' not in signed:
        return False
    try:
        _public_key(public_jwk).verify(from_b64url(signed['sig']), _utf8(canonical(signed['payload'])))
        return True
    except (InvalidSignature, ValueError, TypeError, KeyError):
        return False


# ---------------------------------------------------------------------------
# Agent card, offers and actions
# ---------------------------------------------------------------------------

def identity_extension(identity: Identity) -> dict:
    """The extension block that binds this agent's signing key to its domain."""
    return {'uri': IDENTITY_EXT,
            'description': 'Pactwire signing key for this agent (Ed25519). Deals, deliveries and attestations from this agent are signed with it.',
            'required': False, 'params': {'publicKeyJwk': dict(identity.public_jwk), 'kid': identity.kid}}


def build_agent_card(*, name: str, description: str, version: str, base_url: str, skills: list,
                     identity: Optional[Identity] = None, documentation_url: Optional[str] = None,
                     provider: Optional[dict] = None, extra: Optional[dict] = None) -> dict:
    """A spec-complete A2A 1.0 agent card, the same shape as a2a-lite buildAgentCard()."""
    base = base_url.rstrip('/')
    card: dict = {'name': name, 'description': description, 'version': version}
    if documentation_url:
        card['documentationUrl'] = documentation_url
    if provider:
        card['provider'] = provider
    card['supportedInterfaces'] = [
        {'url': base, 'protocolBinding': 'HTTP+JSON', 'protocolVersion': A2A_PROTOCOL_VERSION},
        {'url': base + '/a2a', 'protocolBinding': 'JSONRPC', 'protocolVersion': A2A_PROTOCOL_VERSION},
    ]
    card['capabilities'] = {'streaming': False, 'pushNotifications': False, 'extendedAgentCard': False}
    card['defaultInputModes'] = ['text/plain', 'application/json']
    card['defaultOutputModes'] = ['text/plain', 'application/json']
    out_skills = []
    for s in skills:
        sk = {'id': s['id'], 'name': s.get('name', s['id']), 'description': s.get('description', ''),
              'tags': list(s['tags']) if s.get('tags') else [s['id']]}
        if s.get('examples'):
            sk['examples'] = s['examples']
        sk['inputModes'] = s.get('inputModes') or ['text/plain', 'application/json']
        sk['outputModes'] = s.get('outputModes') or ['text/plain', 'application/json']
        out_skills.append(sk)
    card['skills'] = out_skills
    card.update(extra or {})
    if identity is not None:
        card['capabilities'] = {**card['capabilities'],
                                'extensions': [*(card['capabilities'].get('extensions') or []), identity_extension(identity)]}
    return card


def make_offer(identity: Identity, *, seller: str, skill: str, task: Any, amount: int, acceptance: list,
               deliver_by: str, currency: str = 'usd', rail: str = 'sandbox', dispatch: bool = True,
               payout: Optional[dict] = None, nonce: Optional[str] = None) -> dict:
    """The buyer's signed terms. Send it with PactwireClient.propose()."""
    terms = {'v': TERMS_VERSION, 'buyer': identity.origin, 'seller': seller, 'skill': skill, 'task': task,
             'price': {'amount': amount, 'currency': currency}, 'acceptance': acceptance, 'deliverBy': deliver_by,
             'rail': rail, 'dispatch': dispatch, 'nonce': nonce or str(uuid.uuid4())}
    if payout:
        terms['payout'] = payout
    return identity.sign(terms)


def action_for(identity: Identity, deal: dict, action: str, **extra: Any) -> dict:
    """A signed deal action: accept, fund, deliver (output=...) or cancel."""
    terms_hash = deal.get('termsHash') or hash_json(deal['terms'])
    deal_id = deal.get('id') or deal.get('dealId')
    return identity.sign({'action': action, 'dealId': deal_id, 'termsHash': terms_hash, **extra})


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _is_loopback(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or '').strip('[]').lower()
    if host == 'localhost' or host.endswith('.localhost'):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_DEFAULT = urllib.request.build_opener()


def _http(method: str, url: str, body: Any = None, headers: Optional[dict] = None, timeout: float = 30) -> tuple:
    data = None
    hdrs = {'accept': 'application/json'}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        hdrs['content-type'] = 'application/json'
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    opener = _DIRECT if _is_loopback(url) else _DEFAULT  # never send local traffic through a proxy
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class PactwireAPIError(Exception):
    def __init__(self, message: str, status: int, code: Optional[str] = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body


class PactwireClient:
    """REST client for a Pactwire service. Every method returns parsed JSON or raises PactwireAPIError."""

    def __init__(self, base_url: str, timeout: float = 90):
        self.base = base_url.rstrip('/')
        self.timeout = timeout

    def _call(self, method: str, path: str, body: Any = None, headers: Optional[dict] = None) -> Any:
        status, raw = _http(method, self.base + path, body, headers=headers, timeout=self.timeout)
        try:
            data = json.loads(raw.decode('utf-8')) if raw else {}
        except ValueError:
            data = {}
        if not 200 <= status < 300:
            err = data.get('error') if isinstance(data, dict) else None
            err = err if isinstance(err, dict) else {}
            raise PactwireAPIError(err.get('message') or f'HTTP {status}', status, err.get('code'), data)
        return data

    def register(self, origin: str) -> dict:
        return self._call('POST', '/v1/agents', {'origin': origin})

    def agents(self, **params: Any) -> dict:
        return self._call('GET', '/v1/agents?' + urllib.parse.urlencode(params))

    def record(self, origin: str) -> dict:
        return self._call('GET', '/v1/agents/record?agent=' + urllib.parse.quote(origin, safe=''))

    def propose(self, offer: dict) -> dict:
        return self._call('POST', '/v1/deals', {'offer': offer})

    def deal(self, deal_id: str, identity: Optional['Identity'] = None) -> dict:
        """Get a deal. Pass your identity (buyer or seller) to see the delivered output; others see only hashes."""
        headers = None
        if identity is not None:
            from datetime import datetime, timezone
            at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            auth = identity.sign({'action': 'read', 'dealId': deal_id, 'at': at})
            headers = {'x-pactwire-read': b64url(_utf8(json.dumps(auth, separators=(',', ':'))))}
        return self._call('GET', f'/v1/deals/{deal_id}', headers=headers)

    def deals(self, party: str = '', state: str = '') -> dict:
        return self._call('GET', '/v1/deals?' + urllib.parse.urlencode({'party': party, 'state': state}))

    def accept(self, deal_id: str, signed: dict) -> dict:
        return self._call('POST', f'/v1/deals/{deal_id}/accept', {'acceptance': signed})

    def fund(self, deal_id: str, signed: dict, funding: Optional[dict] = None) -> dict:
        body = {'authorization': signed}
        if funding is not None:
            body['funding'] = funding
        return self._call('POST', f'/v1/deals/{deal_id}/fund', body)

    def deliver(self, deal_id: str, signed: dict) -> dict:
        return self._call('POST', f'/v1/deals/{deal_id}/deliver', {'delivery': signed})

    def cancel(self, deal_id: str, signed: dict) -> dict:
        return self._call('POST', f'/v1/deals/{deal_id}/cancel', {'cancellation': signed})

    def faucet(self, agent: str, amount: int) -> dict:
        return self._call('POST', '/v1/sandbox/faucet', {'agent': agent, 'amount': amount})

    def balance(self, agent: str) -> dict:
        return self._call('GET', '/v1/sandbox/balance?agent=' + urllib.parse.quote(agent, safe=''))

    def log(self, after: int = 0, limit: int = 100) -> dict:
        return self._call('GET', f'/v1/log?after={int(after)}&limit={int(limit)}')

    def full_log(self) -> list:
        """Every receipt, paging through /v1/log."""
        out: list = []
        while True:
            page = self.log(out[-1]['payload']['seq'] if out else 0, 500)['receipts']
            out.extend(page)
            if len(page) < 500:
                return out

    def jwks(self) -> dict:
        return self._call('GET', '/.well-known/jwks.json')

    def service_key(self) -> dict:
        """The service's public JWK (first key of the JWKS)."""
        return self.jwks()['keys'][0]

    def verify_remote(self, receipts: list) -> dict:
        return self._call('POST', '/v1/verify', {'receipts': receipts})


def send_a2a(base_url: str, text: Optional[str] = None, data: Optional[dict] = None, timeout: float = 30) -> dict:
    """Send one A2A 1.0 HTTP+JSON message to an agent; returns {'text', 'data'} of its reply."""
    parts = []
    if text:
        parts.append({'text': text})
    if data:
        parts.append({'data': data})
    status, raw = _http('POST', base_url.rstrip('/') + '/message:send',
                        {'message': {'messageId': str(uuid.uuid4()), 'role': 'ROLE_USER', 'parts': parts}},
                        headers={'a2a-version': '1.0', 'accept': 'application/a2a+json, application/json'}, timeout=timeout)
    if status != 200:
        raise RuntimeError(f'A2A call returned HTTP {status}: {raw[:200]!r}')
    msg = json.loads(raw.decode('utf-8')).get('message') or {}
    ps = msg.get('parts') or []
    return {'text': '\n'.join(p['text'] for p in ps if isinstance(p, dict) and p.get('text')),
            'data': next((p['data'] for p in ps if isinstance(p, dict) and isinstance(p.get('data'), dict)), None)}


# ---------------------------------------------------------------------------
# A2A 1.0 agent server
# ---------------------------------------------------------------------------

class _InputError(Exception):
    def __init__(self, message: str, code: int = -32602, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def _read_message(message: Any) -> dict:
    if not isinstance(message, dict):
        raise _InputError('message is required')
    if message.get('role') not in ('ROLE_USER', 'user'):
        raise _InputError('message.role must be ROLE_USER')
    parts = message.get('parts')
    if not isinstance(parts, list) or not parts:
        raise _InputError('message.parts must be a non-empty array')
    if len(parts) > 32:
        raise _InputError('message.parts is limited to 32 parts')
    text = '\n'.join(p['text'] for p in parts if isinstance(p, dict) and isinstance(p.get('text'), str) and p['text']).strip()
    data = next((p['data'] for p in parts if isinstance(p, dict) and isinstance(p.get('data'), dict)), None)
    return {'text': text, 'data': data, 'messageId': message.get('messageId'), 'contextId': message.get('contextId') or ''}


def _agent_reply(out: Any, context_id: str) -> dict:
    out = out or {}
    parts = []
    if out.get('text'):
        parts.append({'text': str(out['text'])})
    if out.get('data') is not None:
        parts.append({'data': out['data']})
    if not parts:
        parts.append({'text': ''})
    msg: dict = {'messageId': str(uuid.uuid4())}
    if context_id:
        msg['contextId'] = context_id
    msg['role'] = 'ROLE_AGENT'
    msg['parts'] = parts
    return {'message': msg}


def _resolve(value: Any) -> Any:
    """Let callbacks be plain functions or async functions."""
    return asyncio.run(value) if inspect.isawaitable(value) else value


def _call_work(fn: Callable, task: Any, terms: dict) -> Any:
    try:
        params = [p for p in inspect.signature(fn).parameters.values()
                  if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)]
        two = len(params) >= 2 or any(p.kind == p.VAR_POSITIONAL for p in params)
    except (TypeError, ValueError):
        two = False
    return _resolve(fn(task, terms) if two else fn(task))


class PactwireAgent:
    """An A2A 1.0 agent that does business through Pactwire.

    Serves /.well-known/agent-card.json (with the identity extension), POST /message:send (HTTP+JSON)
    and POST /a2a (JSON-RPC), and answers Pactwire messages like sellerAgent() in agent-kit.mjs:

      ping   -> pong
      offer  -> signed acceptance if the skill is offered and decide_offer(terms) is true
      job    -> work(task[, terms]) and a signed delivery of its output
      verify -> verify(output, check) -> {'verdict': 'pass'|'fail', 'reason': ...} as a signed attestation
      other  -> chat(text, data) -> {'text', 'data'} or a short self-description

    A buyer-only agent is just an agent with no skills (it still needs a card so Pactwire can check its key).
    Call start() to serve it in a background thread; origin is known once it is bound.
    """

    def __init__(self, *, name: str, description: Optional[str] = None, version: str = '1.0.0',
                 skills: Optional[list] = None, work: Optional[Callable] = None, verify: Optional[Callable] = None,
                 decide_offer: Optional[Callable] = None, chat: Optional[Callable] = None,
                 identity: Optional[Identity] = None, host: str = '127.0.0.1', port: int = 0,
                 public_origin: Optional[str] = None, provider: Optional[dict] = None):
        self.name = name
        self.description = description or f'{name} agent'
        self.version = version
        self.skills = list(skills or [])
        self.offered = {s['id'] for s in self.skills}
        self.work, self.verify_fn, self.decide_offer, self.chat = work, verify, decide_offer, chat
        self.provider = provider
        self._identity = identity
        self._host, self._port, self._public_origin = host, port, public_origin
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._card: Optional[dict] = None
        self.identity: Optional[Identity] = None
        self.origin: Optional[str] = None

    # ----- lifecycle -----

    def start(self) -> 'PactwireAgent':
        agent = self

        class Handler(_A2ARequestHandler):
            owner = agent

        self._server = ThreadingHTTPServer((self._host, self._port), Handler)
        self._server.daemon_threads = True
        bound_host, bound_port = self._server.server_address[:2]
        shown = bound_host if bound_host not in ('0.0.0.0', '::') else '127.0.0.1'
        if ':' in shown:
            shown = f'[{shown}]'
        self.origin = (self._public_origin or (self._identity.origin if self._identity and self._identity.origin else None)
                       or f'http://{shown}:{bound_port}').rstrip('/')
        if self._identity is None:
            self.identity = Identity.generate(self.origin)
        else:
            self.identity = self._identity
            if not self.identity.origin:
                self.identity.origin = self.origin
            elif self.identity.origin != self.origin:
                raise ValueError(f'identity origin {self.identity.origin} does not match agent origin {self.origin}')
        self._card = build_agent_card(name=self.name, description=self.description, version=self.version,
                                      base_url=self.origin, skills=self.skills, identity=self.identity, provider=self.provider)
        self._thread = threading.Thread(target=self._server.serve_forever, name=f'a2a:{self.name}', daemon=True)
        self._thread.start()
        return self

    def serve_forever(self) -> None:
        """Start and block (for a standalone agent process)."""
        if not self._server:
            self.start()
        try:
            self._thread.join()
        except KeyboardInterrupt:
            self.close()

    def close(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self) -> 'PactwireAgent':
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        self.close()

    @property
    def card(self) -> dict:
        return self._card

    # ----- the Pactwire conversation -----

    def handle(self, text: str, data: Optional[dict]) -> dict:
        hs = data.get('pactwire') if isinstance(data, dict) else None
        ident = self.identity
        if hs == 'ping':
            return {'text': 'pong', 'data': {'pactwire': 'pong', 'agent': ident.origin}}
        if hs == 'offer':
            terms = data.get('terms') if isinstance(data.get('terms'), dict) else {}
            ok = terms.get('skill') in self.offered and (bool(_resolve(self.decide_offer(terms))) if self.decide_offer else True)
            if not ok:
                return {'text': 'Offer declined.', 'data': {'pactwire': 'declined', 'dealId': data.get('dealId')}}
            acceptance = ident.sign({'action': 'accept', 'dealId': data.get('dealId'), 'termsHash': data.get('termsHash')})
            return {'text': 'Offer accepted.', 'data': {'pactwire': 'accepted', 'acceptance': acceptance}}
        if hs == 'job':
            if not self.work:
                return {'text': 'This agent does not take jobs.'}
            terms = data.get('terms') or {}
            output = _call_work(self.work, terms.get('task'), terms)
            delivery = ident.sign({'action': 'deliver', 'dealId': data.get('dealId'), 'termsHash': data.get('termsHash'), 'output': output})
            return {'text': 'Delivered.', 'data': {'pactwire': 'delivered', 'delivery': delivery}}
        if hs == 'verify':
            if not self.verify_fn:
                return {'text': 'This agent does not verify.'}
            result = _resolve(self.verify_fn(data.get('output'), data.get('check'))) or {}
            verdict = result.get('verdict')
            payload = {'action': 'attest', 'dealId': data.get('dealId'), 'outputHash': data.get('outputHash'),
                       'verdict': 'pass' if verdict == 'pass' else 'fail'}
            if result.get('reason') is not None:  # JS drops an undefined reason
                payload['reason'] = result['reason']
            return {'text': f'Verdict: {verdict}', 'data': {'pactwire': 'attested', 'attestation': ident.sign(payload)}}
        if self.chat:
            return _resolve(self.chat(text, data))
        return {'text': f"I am {self.name}. Skills: {', '.join(self.offered)}. I take paid jobs through Pactwire."}

    def answer(self, body: Any) -> dict:
        msg = _read_message(body.get('message') if isinstance(body, dict) else None)
        return _agent_reply(self.handle(msg['text'], msg['data']), msg['contextId'])


SellerAgent = PactwireAgent


class _A2ARequestHandler(BaseHTTPRequestHandler):
    owner: PactwireAgent
    protocol_version = 'HTTP/1.1'
    server_version = 'pactwire-kit-python'
    CORS = {'access-control-allow-origin': '*'}

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet
        pass

    def _send(self, status: int, body: Any, ctype: str, extra: Optional[dict] = None) -> None:
        raw = b'' if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        headers = {**self.CORS, **(extra or {})}
        if body is not None:
            headers['content-type'] = ctype
        headers['content-length'] = str(len(raw))
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if raw and self.command != 'HEAD':
            self.wfile.write(raw)

    def _problem(self, status: int, title: str, detail: str, extra: Optional[dict] = None) -> None:
        slug = ''.join(c if c.isalnum() else '-' for c in title.lower())
        while '--' in slug:
            slug = slug.replace('--', '-')
        self._send(status, {'type': f'https://a2a-protocol.org/errors/{slug}', 'title': title, 'status': status, 'detail': detail},
                   'application/problem+json; charset=utf-8', extra)

    def _respond(self, value: Any) -> None:
        self._send(200, value, f'{A2A_MEDIA_TYPE}; charset=utf-8', {'x-content-type-options': 'nosniff'})

    def _path(self) -> str:
        return urllib.parse.urlsplit(self.path).path

    def _version_ok(self) -> bool:
        v = self.headers.get('a2a-version')
        return not v or v in SUPPORTED_A2A_VERSIONS

    def _read_body(self) -> Any:
        if 'chunked' in (self.headers.get('transfer-encoding') or '').lower():
            raw = b''
            while True:
                size = int(self.rfile.readline().split(b';')[0].strip() or b'0', 16)
                if size == 0:
                    while self.rfile.readline() not in (b'\r\n', b'\n', b''):
                        pass
                    break
                raw += self.rfile.read(size)
                self.rfile.readline()
                if len(raw) > MAX_A2A_BYTES:
                    self.close_connection = True
                    raise _InputError(f'request is limited to {MAX_A2A_BYTES} bytes', -32600, 413)
        else:
            n = int(self.headers.get('content-length') or 0)
            if n > MAX_A2A_BYTES:
                self.close_connection = True
                raise _InputError(f'request is limited to {MAX_A2A_BYTES} bytes', -32600, 413)
            raw = self.rfile.read(n) if n else b''
        try:
            return json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            raise _InputError('body must be JSON', -32700, 400) from None

    def do_OPTIONS(self) -> None:
        self._send(204, None, '', {'access-control-allow-methods': 'GET, POST, OPTIONS',
                                   'access-control-allow-headers': 'content-type, authorization, a2a-version, a2a-extensions'})

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        p = self._path()
        if p in ('/.well-known/agent-card.json', '/.well-known/agent.json'):
            return self._send(200, self.owner.card, 'application/json; charset=utf-8', {'cache-control': 'public, max-age=300'})
        if p in ('/message:send', '/a2a'):
            return self._problem(405, 'Method Not Allowed', 'Use POST.', {'allow': 'POST'})
        return self._route_misc(p)

    def _route_misc(self, p: str) -> None:
        if p == '/message:stream':
            return self._problem(501, 'Unsupported Operation', 'This agent does not stream; use message:send.')
        if p.startswith('/tasks/'):
            return self._problem(404, 'Task Not Found', 'This agent answers with direct messages and stores no tasks.')
        return self._problem(404, 'Not Found', 'Unknown A2A route.')

    def do_POST(self) -> None:
        p = self._path()
        if p in ('/.well-known/agent-card.json', '/.well-known/agent.json'):
            return self._problem(405, 'Method Not Allowed', 'Use GET.', {'allow': 'GET'})
        if p == '/message:send':
            if not self._version_ok():
                return self._problem(400, 'Version Not Supported', f"Supported A2A versions: {', '.join(SUPPORTED_A2A_VERSIONS)}.")
            try:
                return self._respond(self.owner.answer(self._read_body()))
            except _InputError as e:
                return self._problem(e.status, 'Invalid Request', str(e))
            except Exception:
                return self._problem(500, 'Internal Error', 'The agent failed to answer.')
        if p == '/a2a':
            return self._jsonrpc()
        return self._route_misc(p)

    def _jsonrpc(self) -> None:
        try:
            rpc = self._read_body()
        except _InputError as e:
            return self._respond({'jsonrpc': '2.0', 'id': None, 'error': {'code': e.code, 'message': str(e)}})
        rid = rpc.get('id') if isinstance(rpc, dict) else None

        def fail(code: int, message: str) -> None:
            self._respond({'jsonrpc': '2.0', 'id': rid, 'error': {'code': code, 'message': message}})

        if not isinstance(rpc, dict) or rpc.get('jsonrpc') != '2.0' or not isinstance(rpc.get('method'), str):
            return fail(-32600, 'Invalid JSON-RPC 2.0 request')
        if not self._version_ok():
            return fail(-32009, f"Supported A2A versions: {', '.join(SUPPORTED_A2A_VERSIONS)}")
        m = rpc['method']
        if m in ('SendMessage', 'message/send'):
            try:
                return self._respond({'jsonrpc': '2.0', 'id': rid, 'result': self.owner.answer(rpc.get('params'))})
            except _InputError as e:
                return fail(e.code, str(e))
            except Exception:
                return fail(-32603, 'The agent failed to answer.')
        if m in ('GetTask', 'CancelTask', 'tasks/get', 'tasks/cancel'):
            return fail(-32001, 'This agent answers with direct messages and stores no tasks.')
        if m in ('SendStreamingMessage', 'SubscribeToTask', 'message/stream'):
            return fail(-32004, 'Streaming is not supported; use SendMessage.')
        if m in ('CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig',
                 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig'):
            return fail(-32003, 'Push notifications are not supported.')
        return fail(-32601, f'Method not found: {m[:80]}')


# ---------------------------------------------------------------------------
# Receipt log
# ---------------------------------------------------------------------------

def verify_chain(receipts: list, public_jwk: dict, expect_start_prev: Optional[str] = None) -> dict:
    """Verify a run of receipts offline with the service key from /.well-known/jwks.json.
    Same rules as verifyChain() in src/receipts.mjs."""
    problems = []
    first = (receipts[0].get('payload') or {}) if receipts else {}
    prev = expect_start_prev if expect_start_prev is not None else (GENESIS if first.get('seq') == 1 else first.get('prevHash'))
    for r in receipts:
        signed = {k: v for k, v in r.items() if k != 'hash'}
        seq = (r.get('payload') or {}).get('seq')
        if not verify(signed, public_jwk):
            problems.append(f'seq {seq}: bad signature')
        recomputed = hash_json(signed)
        if r.get('hash') and recomputed != r['hash']:
            problems.append(f'seq {seq}: hash mismatch')
        if (r.get('payload') or {}).get('prevHash') != prev:
            problems.append(f'seq {seq}: chain broken (prevHash does not match)')
        prev = recomputed
    return {'ok': not problems, 'problems': problems, 'head': prev, 'count': len(receipts)}


def verify_receipt(receipt: dict, public_jwk: dict) -> dict:
    signed = {k: v for k, v in receipt.items() if k != 'hash'}
    sig_ok = verify(signed, public_jwk)
    hash_ok = not receipt.get('hash') or hash_json(signed) == receipt['hash']
    return {'ok': sig_ok and hash_ok, 'sigOk': sig_ok, 'hashOk': hash_ok}
