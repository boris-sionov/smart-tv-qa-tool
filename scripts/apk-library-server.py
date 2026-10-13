#!/usr/bin/env python3
"""The APK library the QA tool's "Install from library" reads and uploads to.

Runs on freetv-server, reachable over Tailscale only. Standard library only, no sudo:

    GET  /            the APKs as nginx-autoindex-style JSON: [{name, type, mtime, size}]
    GET  /<name>.apk  the file
    PUT  /<name>.apk  stores the body; 409 when it exists, unless ?overwrite=1

Install (as the server user):
    mkdir -p ~/apk-library/apks && cp apk-library-server.py ~/apk-library/server.py
    (crontab -l 2>/dev/null; echo '@reboot ~/apk-library/run.sh') | crontab -
where run.sh restarts this in a loop — Tailscale's address is not up yet early in boot, so the
first binds fail until it is.
"""

import json
import os
import sys
from email.utils import formatdate
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = os.path.expanduser(os.environ.get('APK_LIBRARY', '~/apk-library/apks'))
MAX_SIZE = 1024 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _apk_name(self):
        """The file name a PUT names, or None unless it is a plain `*.apk` at the root."""
        name = unquote(urlsplit(self.path).path).lstrip('/')
        if not name.lower().endswith('.apk') or '/' in name or '\\' in name or name.startswith('.'):
            return None
        return name

    def do_GET(self):
        if urlsplit(self.path).path != '/':
            return super().do_GET()
        entries = []
        for entry in os.scandir(ROOT):
            if entry.is_file() and entry.name.lower().endswith('.apk'):
                stat = entry.stat()
                entries.append({'name': entry.name, 'type': 'file', 'size': stat.st_size,
                                'mtime': formatdate(stat.st_mtime, usegmt=True)})
        body = json.dumps(entries).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        name = self._apk_name()
        length = int(self.headers.get('Content-Length') or 0)
        if not name:
            return self.send_error(400, 'Only *.apk files at the library root')
        if not 0 < length <= MAX_SIZE:
            return self.send_error(413, 'Empty or too large')
        path = os.path.join(ROOT, name)
        overwrite = parse_qs(urlsplit(self.path).query).get('overwrite') == ['1']
        if os.path.exists(path) and not overwrite:
            return self.send_error(409, f'{name} is already in the library')
        partial = path + '.part'
        with open(partial, 'wb') as out:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    os.remove(partial)
                    return self.send_error(400, 'Upload broke off')
                out.write(chunk)
                remaining -= len(chunk)
        os.replace(partial, path)
        self.log_message('stored %s (%d bytes)', name, length)
        self.send_response(201)
        self.send_header('Content-Length', '0')
        self.end_headers()


if __name__ == '__main__':
    host, port = sys.argv[1], int(sys.argv[2])
    os.makedirs(ROOT, exist_ok=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
