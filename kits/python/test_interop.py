"""Cross-language interop: Python agents doing real deals through the JavaScript Pactwire service.

Run:  cd ai-pipeline/kits/python && python3 -m unittest test_interop -v
Needs Node 20+ with ai-pipeline's node_modules installed, Python 3.9+ and `cryptography`.
"""

import base64
import copy
import json
import os
import sys
from pathlib import Path
import subprocess
import threading
import unittest

import pactwire_kit as hk

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
# Path.as_uri() gives file:///C:/... on Windows and file:///home/... elsewhere; string-joining breaks on Windows.
CRYPTO = Path(ROOT, 'src', 'crypto.mjs').as_uri()
DOCTOR = Path(ROOT, 'src', 'doctor.mjs').as_uri()

# Values chosen to break naive canonical JSON: key order by UTF-16 code units (an emoji key sorts
# before U+FFFF), escapes, control characters, U+2028, lone surrogates, non-ASCII, -0, floats,
# integers past 2^53 (JavaScript rounds them), exponent forms, empty containers, deep nesting.
TRICKY = [
    None, True, False, 0, -0.0, 1, -1, 1.5, 0.1, 0.2 + 0.1, 1.0, 100.0, -2.5e-7, 1e21, 1e20, 123456789012345680000.0,
    1e-6, 1e-7, 5e-324, 1.7976931348623157e308, 2 ** 53, 2 ** 53 + 1, -(2 ** 53) - 1, 2 ** 64, 12345678901234567890, 10 ** 21,
    '', 'plain', 'quote " backslash \\ slash /', 'tab\tnl\ncr\rbs\bff\f', '\x00\x01\x1f\x7f', '  ',
    'café 日本語 \U0001F600 \U0001F44D\U0001F3FD', '\ud800 lone', 'lone \udfff', '<script>&\'',
    [], {}, [[]], [{}], {'': ''}, {'a': {}}, {'a': []},
    {'b': 1, 'a': 2, 'A': 3, '_': 4, '10': 5, '9': 6, 'é': 7, '￿': 8, '\U0001F600': 9, 'aa': 10, 'a\x00': 11},
    {'nested': {'z': [1, {'y': None, 'x': [True, False, {'deep': ['\U0001F680', 0.5, -0.0]}]}], 'a': 'end'}},
    {'big': [2 ** 63 - 1, -(2 ** 63), 9007199254740993], 'small': [0.1, 1.5, 3.14159, -1e-10]},
]


def node(script, stdin=''):
    r = subprocess.run(['node', '--input-type=module', '-e', script], input=stdin, capture_output=True, text=True, encoding='utf-8', cwd=ROOT, timeout=120)
    if r.returncode != 0:
        raise AssertionError(f'node failed:\n{r.stderr}')
    return r.stdout


SUMMARY_CHECKS = [
    {'type': 'json_schema', 'schema': {'type': 'object', 'required': ['summary', 'wordCount', 'sourceSha256'], 'properties': {
        'summary': {'type': 'string', 'minLength': 10, 'maxLength': 200},
        'wordCount': {'type': 'integer', 'minimum': 1},
        'sourceSha256': {'type': 'string', 'pattern': '^[0-9a-f]{64}$'}}}},
    {'type': 'max_bytes', 'bytes': 4000},
]
SOURCE = ('Agents need a way to hold money until work is checked. Pactwire holds it and settles by rules both sides '
          'signed — café, 日本語, \U0001F600.')
EXTRAS = {'floats': [1.5, 0.1, 1e21, -0.0], 'big': 2 ** 53 + 1, 'text': 'tab\t"q"   \U0001F680', 'empty': [{}, []], '\U0001F600': 1, '￿': 2}


def honest_work(task, terms):
    assert terms['skill'] == 'summarize'
    text = task['text']
    return {'summary': text.split('.')[0][:120] + '.', 'wordCount': len(text.split()),
            'sourceSha256': hk.sha256_hex(text), 'echo': task['extras']}


def cheat_work(task):
    return {'summary': 'ok'}


def verify_french(output, check):
    return {'verdict': 'pass' if output.get('fr') == 'bonjour' else 'fail', 'reason': 'dictionnaire ✓'}


class PythonAgentsThroughJsPactwire(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.Popen(['node', os.path.join(HERE, 'start-pactwire.mjs')], cwd=ROOT,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        line = [None]
        t = threading.Thread(target=lambda: line.__setitem__(0, cls.proc.stdout.readline()), daemon=True)
        t.start()
        t.join(30)
        if not line[0] or not line[0].startswith('http'):
            cls.proc.kill()
            raise RuntimeError(f'Pactwire did not start: {line[0]!r} {cls.proc.stderr.read() if cls.proc.poll() is not None else ""}')
        cls.base = line[0].strip()
        cls.api = hk.PactwireClient(cls.base)
        skill = [{'id': 'summarize', 'name': 'Summarize', 'description': 'Summarize text', 'tags': ['text']}]
        cls.buyer = hk.PactwireAgent(name='Py Buyer').start()
        cls.seller = hk.PactwireAgent(name='Py Honest Summarizer', skills=skill, work=honest_work).start()
        cls.cheat = hk.PactwireAgent(name='Py Cheap Summarizer', skills=skill, work=cheat_work).start()
        cls.translator = hk.PactwireAgent(name='Py Translator', skills=[{'id': 'translate', 'name': 'Translate', 'description': 'en->fr'}],
                                           work=lambda task: {'fr': 'bonjour' if task.get('en') == 'hello' else '???'}).start()
        cls.verifier = hk.PactwireAgent(name='Py French Checker', skills=[{'id': 'verify_fr', 'name': 'Verify French', 'description': 'checks translations'}],
                                         verify=verify_french).start()
        cls.agents = [cls.buyer, cls.seller, cls.cheat, cls.translator, cls.verifier]
        cls.registered = {a.origin: cls.api.register(a.origin) for a in cls.agents}
        cls.api.faucet(cls.buyer.origin, 1000)

    @classmethod
    def tearDownClass(cls):
        for a in getattr(cls, 'agents', []):
            a.close()
        try:
            cls.proc.stdin.close()
            cls.proc.wait(10)
        except Exception:
            cls.proc.kill()
        for s in (cls.proc.stdout, cls.proc.stderr):
            s.close()

    # ---------- primitives against the JavaScript reference ----------

    def test_01_canonical_bytes_match_node(self):
        wire = json.dumps(TRICKY, ensure_ascii=True)  # what a Python agent actually sends over HTTP
        out = node(f"""
            import {{ canonical }} from '{CRYPTO}';
            let raw = ''; for await (const c of process.stdin) raw += c;
            const vals = JSON.parse(raw);
            process.stdout.write(JSON.stringify(vals.map(v => Buffer.from(canonical(v), 'utf8').toString('base64'))));
        """, wire)
        js = [base64.b64decode(s) for s in json.loads(out)]
        self.assertEqual(len(js), len(TRICKY))
        for value, js_bytes in zip(TRICKY, js):
            py_bytes = hk.canonical(value).encode('utf-8')
            self.assertEqual(py_bytes, js_bytes, f'value {value!r}: python {py_bytes!r} != node {js_bytes!r}')
            # and the same after a round trip through JSON parsing in Python
            self.assertEqual(hk.canonical(json.loads(json.dumps(value))).encode('utf-8'), js_bytes)
        # the whole list at once, and its hash
        whole = node(f"import {{ canonical, hashJson }} from '{CRYPTO}'; let r=''; for await (const c of process.stdin) r+=c;"
                     f" process.stdout.write(await hashJson(JSON.parse(r)));", wire)
        self.assertEqual(hk.hash_json(TRICKY), whole)
        for bad in (float('nan'), float('inf'), {'x': [float('-inf')]}, 10 ** 400):
            with self.assertRaises(ValueError):
                hk.canonical(bad)

    def test_02_signatures_cross_language(self):
        ident = hk.Identity.generate('https://py.example')
        payload = {'msg': 'héllo \U0001F600', 'n': [1.5, 0.1, 2 ** 53 + 1], 'z': {'￿': 1, '\U0001F600': 2}}
        signed = ident.sign(payload)
        out = node(f"""
            import {{ verify, keyId, sign, generateKeyPair }} from '{CRYPTO}';
            let raw = ''; for await (const c of process.stdin) raw += c;
            const {{ signed, jwk, payload }} = JSON.parse(raw);
            const tampered = structuredClone(signed); tampered.payload.msg += '!';
            const k = await generateKeyPair();
            const js = await sign(payload, 'https://js.example', k.privateJwk);
            process.stdout.write(JSON.stringify({{ ok: await verify(signed, jwk), tampered: await verify(tampered, jwk), kid: await keyId(jwk), js, jsKey: k.publicJwk, jsKid: await keyId(k.publicJwk) }}));
        """, json.dumps({'signed': signed, 'jwk': ident.public_jwk, 'payload': payload}))
        r = json.loads(out)
        self.assertTrue(r['ok'], 'Node verifies a Python signature')
        self.assertFalse(r['tampered'])
        self.assertEqual(r['kid'], ident.kid, 'RFC 7638 thumbprint matches keyId()')
        self.assertTrue(hk.verify(r['js'], r['jsKey']), 'Python verifies a Node signature')
        self.assertEqual(hk.key_id(r['jsKey']), r['jsKid'])
        bad = copy.deepcopy(r['js'])
        bad['payload']['n'][0] = 1.25
        self.assertFalse(hk.verify(bad, r['jsKey']))
        self.assertFalse(hk.verify({'payload': payload, 'sig': 'AAAA'}, r['jsKey']))
        self.assertFalse(hk.verify(signed, {'kty': 'RSA'}))
        # Ed25519 is deterministic: the same key signs the same bytes identically in both languages
        again = hk.sign(payload, 'https://py.example', ident.private_jwk)
        self.assertEqual(again['sig'], signed['sig'])

    def test_03_official_a2a_sdk_accepts_python_agent(self):
        out = node(f"import {{ checkA2A }} from '{DOCTOR}'; const r = await checkA2A('{self.seller.origin}');"
                   f" process.stdout.write(JSON.stringify({{ ok: r.ok, steps: r.steps }}));")
        r = json.loads(out)
        self.assertTrue(r['ok'], json.dumps([s for s in r['steps'] if not s['ok']]))
        card = json.loads(hk._http('GET', self.seller.origin + '/.well-known/agent-card.json')[1])
        self.assertIn({'url': self.seller.origin, 'protocolBinding': 'HTTP+JSON', 'protocolVersion': '1.0'}, card['supportedInterfaces'])
        ext = card['capabilities']['extensions'][0]
        self.assertEqual(ext['uri'], hk.IDENTITY_EXT)
        self.assertEqual(ext['params']['kid'], self.seller.identity.kid)
        # JSON-RPC binding works too
        rpc = json.loads(hk._http('POST', self.seller.origin + '/a2a', {'jsonrpc': '2.0', 'id': 7, 'method': 'SendMessage', 'params': {
            'message': {'messageId': 'm1', 'role': 'ROLE_USER', 'parts': [{'data': {'pactwire': 'ping'}}]}}})[1])
        self.assertEqual(rpc['result']['message']['parts'][1]['data'], {'pactwire': 'pong', 'agent': self.seller.origin})

    def test_04_registration_checked_live_by_pactwire(self):
        for a in self.agents:
            reg = self.registered[a.origin]
            self.assertTrue(reg['verified'], json.dumps(reg['lastCheck']))
            self.assertEqual(reg['kid'], a.identity.kid, 'JS thumbprint == Python thumbprint')
            self.assertEqual(reg['publicJwk'], a.identity.public_jwk)
        found = self.api.agents(q='summarize')['agents']
        self.assertEqual(sorted(x['id'] for x in found), sorted([self.seller.origin, self.cheat.origin]))

    # ---------- real deals ----------

    def test_05_honest_python_seller_is_paid(self):
        task = {'text': SOURCE, 'extras': EXTRAS}
        checks = SUMMARY_CHECKS + [{'type': 'sha256', 'path': 'echo', 'equals': hk.hash_json(EXTRAS)},
                                   {'type': 'field_equals', 'path': 'sourceSha256', 'value': hk.sha256_hex(SOURCE)}]
        offer = hk.make_offer(self.buyer.identity, seller=self.seller.origin, skill='summarize', task=task, amount=250,
                              acceptance=checks, deliver_by=hk.in_minutes(30), dispatch=True)
        deal = self.api.propose(offer)
        # JS computed the same terms hash and deal id from the Python-signed terms
        self.assertEqual(deal['termsHash'], hk.hash_json(offer['payload']))
        self.assertEqual(deal['id'], 'deal_' + hk.hash_json(offer['payload'])[:24])
        self.assertEqual(deal['state'], 'accepted', 'Pactwire notified the Python seller, which accepted with a Python signature')
        self.assertEqual(deal['acceptance']['signer'], self.seller.origin)
        self.assertTrue(hk.verify(deal['acceptance'], self.seller.identity.public_jwk))
        deal = self.api.fund(deal['id'], hk.action_for(self.buyer.identity, deal, 'fund'))
        self.assertEqual(deal['state'], 'released', json.dumps(deal.get('verdict')))
        self.assertTrue(deal['verdict']['pass'])
        self.assertEqual([r['payload']['kind'] for r in deal['receipts']],
                         ['deal.proposed', 'deal.accepted', 'deal.funded', 'deal.dispatched', 'deal.delivered', 'deal.verified', 'deal.released'])
        delivery = deal['delivery']
        self.assertTrue(hk.verify(delivery, self.seller.identity.public_jwk))
        self.assertEqual(deal['verdict']['outputHash'], hk.hash_json(delivery['payload']['output']))
        self.assertEqual(self.api.balance(self.buyer.origin)['balance'], 750)
        self.assertEqual(self.api.balance(self.seller.origin)['balance'], 250)
        # Outsiders see only hashes; the buyer, signing a read request in Python, sees the output.
        self.assertNotIn('output', self.api.deal(deal['id'])['delivery']['payload'])
        self.assertEqual(self.api.deal(deal['id'], self.buyer.identity)['delivery']['payload']['output'], delivery['payload']['output'])
        type(self).deal1 = deal

    def test_06_cheating_python_seller_is_refunded(self):
        offer = hk.make_offer(self.buyer.identity, seller=self.cheat.origin, skill='summarize', task={'text': SOURCE}, amount=300,
                              acceptance=SUMMARY_CHECKS, deliver_by=hk.in_minutes(30))
        deal = self.api.propose(offer)
        self.assertEqual(deal['state'], 'accepted')
        deal = self.api.fund(deal['id'], hk.action_for(self.buyer.identity, deal, 'fund'))
        self.assertEqual(deal['state'], 'refunded')
        self.assertFalse(deal['verdict']['pass'])
        self.assertRegex(deal['verdict']['results'][0]['detail'], 'missing wordCount')
        self.assertEqual(deal['receipts'][-1]['payload']['kind'], 'deal.refunded')
        self.assertEqual(self.api.balance(self.buyer.origin)['balance'], 750)
        self.assertEqual(self.api.balance(self.cheat.origin)['balance'], 0)
        # a second delivery cannot settle twice
        with self.assertRaises(hk.PactwireAPIError) as e:
            self.api.deliver(deal['id'], hk.action_for(self.cheat.identity, deal, 'deliver', output={'summary': 'again'}))
        self.assertEqual(e.exception.code, 'bad_state')
        self.assertEqual(self.api.record(self.cheat.origin)['payload']['sandbox']['seller']['failedOrLate'], 1)

    def test_07_python_verifier_attests_and_manual_flow(self):
        acceptance = [{'type': 'verifier_agent', 'agent': self.verifier.origin}]
        good = self.api.propose(hk.make_offer(self.buyer.identity, seller=self.translator.origin, skill='translate', task={'en': 'hello'},
                                              amount=100, acceptance=acceptance, deliver_by=hk.in_minutes(10)))
        good = self.api.fund(good['id'], hk.action_for(self.buyer.identity, good, 'fund'))
        self.assertEqual(good['state'], 'released', json.dumps(good['verdict']))
        att = good['verdict']['results'][0]['attestation']
        self.assertEqual(att['signer'], self.verifier.origin)
        self.assertEqual(att['payload']['reason'], 'dictionnaire ✓')
        bad = self.api.propose(hk.make_offer(self.buyer.identity, seller=self.translator.origin, skill='translate', task={'en': 'cat'},
                                             amount=100, acceptance=acceptance, deliver_by=hk.in_minutes(10)))
        bad = self.api.fund(bad['id'], hk.action_for(self.buyer.identity, bad, 'fund'))
        self.assertEqual(bad['state'], 'refunded')
        # manual (no dispatch) flow driven entirely by Python-signed REST calls; also Mallory cannot deliver
        manual = self.api.propose(hk.make_offer(self.buyer.identity, seller=self.translator.origin, skill='translate', task={'en': 'hello'},
                                                amount=50, acceptance=[{'type': 'field_equals', 'path': 'fr', 'value': 'bonjour'}],
                                                deliver_by=hk.in_minutes(10), dispatch=False))
        self.assertEqual(manual['state'], 'accepted')
        manual = self.api.fund(manual['id'], hk.action_for(self.buyer.identity, manual, 'fund'))
        self.assertEqual(manual['state'], 'funded')
        with self.assertRaises(hk.PactwireAPIError) as e:
            self.api.deliver(manual['id'], hk.action_for(self.cheat.identity, manual, 'deliver', output={'fr': 'bonjour'}))
        self.assertEqual(e.exception.code, 'wrong_signer')
        manual = self.api.deliver(manual['id'], hk.action_for(self.translator.identity, manual, 'deliver', output={'fr': 'bonjour'}))
        self.assertEqual(manual['state'], 'released')
        self.assertEqual(self.api.balance(self.buyer.origin)['balance'], 750 - 100 - 50)
        self.assertEqual(self.api.balance(self.translator.origin)['balance'], 150)

    # ---------- the public log ----------

    def test_08_whole_log_verifies_in_python(self):
        pub = self.api.service_key()
        receipts = self.api.full_log()
        kinds = [r['payload']['kind'] for r in receipts]
        self.assertEqual(kinds.count('agent.key'), len(self.agents))
        self.assertIn('deal.released', kinds)
        self.assertIn('deal.refunded', kinds)
        self.assertEqual(receipts[0]['payload']['prevHash'], hk.GENESIS)
        res = hk.verify_chain(receipts, pub)
        self.assertTrue(res['ok'], res['problems'])
        self.assertEqual(res['count'], len(receipts))
        self.assertEqual(res['head'], receipts[-1]['hash'])
        self.assertEqual(self.api.verify_remote(receipts)['head'], res['head'], 'JS and Python agree on the chain head')
        self.assertTrue(hk.verify_receipt(receipts[0], pub)['ok'])
        # any edit, removal or reordering is caught
        forged = copy.deepcopy(receipts)
        next(r for r in forged if r['payload']['kind'] == 'deal.refunded')['payload']['data']['paidTo'] = self.cheat.origin
        self.assertFalse(hk.verify_chain(forged, pub)['ok'])
        self.assertFalse(hk.verify_chain(receipts[:3] + receipts[4:], pub)['ok'])
        swapped = receipts[:]
        swapped[2], swapped[3] = swapped[3], swapped[2]
        self.assertFalse(hk.verify_chain(swapped, pub)['ok'])
        other = hk.Identity.generate('https://x.example').public_jwk
        self.assertFalse(hk.verify_chain(receipts, other)['ok'])
        # a run that does not start at seq 1 verifies against its own first prevHash
        self.assertTrue(hk.verify_chain(receipts[5:], pub)['ok'])


class IdentityStorage(unittest.TestCase):
    def test_save_and_load(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'id.json')
            a = hk.Identity.load_or_create(path, 'https://agent.example')
            if sys.platform != 'win32':  # Windows has no owner-only mode bits; it reports 0o666
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            b = hk.Identity.load_or_create(path)
            self.assertEqual((a.kid, a.origin), (b.kid, b.origin))
            self.assertTrue(hk.verify(b.sign({'x': 1}), a.public_jwk))


if __name__ == '__main__':
    unittest.main(verbosity=2)
