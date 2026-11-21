"""Verify real WinHTTP decoding against a local HTTP server; no Google calls."""
import ctypes
from ctypes import wintypes as W
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import zlib

if sys.platform != 'win32':
    raise SystemExit('This verification requires Windows')

LIMIT = 8 * 1024 * 1024
BODY = b'{"submissionId":"synthetic-stable-id"}'
payload = json.dumps({'ok': True, 'test': {'questions': [
    {'id': str(i), 'text': str(i) + ' Український текст питання. ' * 30,
     'answers': [{'id': str(j), 'text': 'Варіант відповіді. ' * 20} for j in range(6)]}
    for i in range(200)]}}, ensure_ascii=False, separators=(',', ':')).encode()
packets = {'/plain': (payload, None), '/gzip': (gzip.compress(payload), 'gzip'),
           '/deflate': (zlib.compress(payload), 'deflate'), '/broken': (b'bad-gzip', 'gzip'),
           '/expanded': (gzip.compress(b'{"t":"' + b'A' * (LIMIT - 7) + b'"}'), 'gzip')}
posts, seen, checks = [], [], []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        posts.append(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        self.reply()

    def do_GET(self):
        self.reply()

    def reply(self):
        seen.append(self.path)
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/gzip')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        raw, encoding = packets[self.path]
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        if encoding:
            self.send_header('Content-Encoding', encoding)
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


api = ctypes.WinDLL('winhttp', use_last_error=True)
HANDLE, VOID = W.HANDLE, ctypes.c_void_p
DWORDP = ctypes.POINTER(W.DWORD)
signatures = {
    'WinHttpOpen': (HANDLE, [W.LPCWSTR, W.DWORD, W.LPCWSTR, W.LPCWSTR, W.DWORD]),
    'WinHttpSetTimeouts': (W.BOOL, [HANDLE, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]),
    'WinHttpConnect': (HANDLE, [HANDLE, W.LPCWSTR, W.WORD, W.DWORD]),
    'WinHttpOpenRequest': (HANDLE, [HANDLE, W.LPCWSTR, W.LPCWSTR, W.LPCWSTR, W.LPCWSTR, ctypes.POINTER(W.LPCWSTR), W.DWORD]),
    'WinHttpSetOption': (W.BOOL, [HANDLE, W.DWORD, VOID, W.DWORD]),
    'WinHttpSendRequest': (W.BOOL, [HANDLE, W.LPCWSTR, W.DWORD, VOID, W.DWORD, W.DWORD, ctypes.c_size_t]),
    'WinHttpReceiveResponse': (W.BOOL, [HANDLE, VOID]),
    'WinHttpQueryHeaders': (W.BOOL, [HANDLE, W.DWORD, W.LPCWSTR, VOID, DWORDP, DWORDP]),
    'WinHttpQueryDataAvailable': (W.BOOL, [HANDLE, DWORDP]),
    'WinHttpReadData': (W.BOOL, [HANDLE, VOID, W.DWORD, DWORDP]),
    'WinHttpCloseHandle': (W.BOOL, [HANDLE]),
}
for name, (result, arguments) in signatures.items():
    getattr(api, name).restype = result
    getattr(api, name).argtypes = arguments


def ok(value):
    if not value:
        raise OSError(ctypes.get_last_error(), 'WinHTTP verification call failed')
    return value


def request(port, path, compressed=True):
    session = connection = handle = None
    try:
        session = ok(api.WinHttpOpen('Litakova-local-transport-check', 1, None, None, 0))
        ok(api.WinHttpSetTimeouts(session, 5000, 5000, 5000, 5000))
        connection = ok(api.WinHttpConnect(session, '127.0.0.1', port, 0))
        handle = ok(api.WinHttpOpenRequest(connection, 'POST', path, None, None, None, 0))
        if compressed:
            flags = W.DWORD(1)
            ok(api.WinHttpSetOption(handle, 118, ctypes.byref(flags), ctypes.sizeof(flags)))
        body = ctypes.create_string_buffer(BODY)
        ok(api.WinHttpSendRequest(handle, 'Content-Type: application/json; charset=utf-8\r\nAccept: application/json\r\n', 0xffffffff, body, len(BODY), len(BODY), 0))
        ok(api.WinHttpReceiveResponse(handle, None))
        status, size = W.DWORD(), W.DWORD(4)
        ok(api.WinHttpQueryHeaders(handle, 19 | 0x20000000, None, ctypes.byref(status), ctypes.byref(size), None))
        assert status.value == 200
        chunks, length = [], 0
        while True:
            available = W.DWORD()
            ok(api.WinHttpQueryDataAvailable(handle, ctypes.byref(available)))
            if not available.value:
                break
            if available.value > LIMIT - length:
                raise ValueError('Decoded reply exceeds MAX_BODY')
            buffer, got = ctypes.create_string_buffer(available.value), W.DWORD()
            ok(api.WinHttpReadData(handle, buffer, available.value, ctypes.byref(got)))
            assert got.value > 0
            chunks.append(buffer.raw[:got.value])
            length += got.value
        raw = b''.join(chunks)
        assert raw.lstrip(b' \r\n').startswith(b'{')
        return raw
    finally:
        for handle in [handle, connection, session]:
            if handle:
                api.WinHttpCloseHandle(handle)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
server.daemon_threads = True
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    for name, compressed in [('/plain', False), ('/gzip', True), ('/redirect', True)]:
        actual = request(server.server_port, name, compressed)
        assert actual == payload
        assert len(json.loads(actual)['test']['questions']) == 200
        checks.append('Exact 200-question Unicode response: ' + name)
        print('PASS ' + checks[-1], flush=True)
    assert seen[-2:] == ['/redirect', '/gzip']
    for path in ['/broken', '/expanded']:
        try:
            request(server.server_port, path)
        except (OSError, ValueError, AssertionError) as error:
            if path == '/expanded':
                assert isinstance(error, ValueError) and 'MAX_BODY' in str(error), str(error)
            checks.append('Rejected invalid or oversized decoded response: ' + path)
            print('PASS ' + checks[-1], flush=True)
        else:
            raise AssertionError('Invalid compressed data was accepted: ' + path)
    assert posts and all(value == BODY for value in posts)
    report = {'status': 'passed', 'passed': len(checks), 'checks': checks,
              'actualWindowsWinHTTPExecuted': True, 'gzipVerified': True,
              'redirectVerified': True, 'postBytesUnchanged': True,
              'decodedLimitBytes': LIMIT, 'plainBytes': len(payload),
              'syntheticGzipBytes': len(packets['/gzip'][0]),
              'decodedSha256': hashlib.sha256(payload).hexdigest(),
              'productionRPCRequests': 0, 'liveGoogleCompressionMeasured': False}
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report), flush=True)
finally:
    server.shutdown()
    server.server_close()
