#!/usr/bin/env python3
"""
Game Tracker — Local dev server
Usage:  python serve.py [port]   (default port: 8080)
"""
import sys, os, socket, threading, mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
from pathlib import Path

PORT = 8080
args = [a for a in sys.argv[1:] if not a.startswith('--')]
if args:
    try: PORT = int(args[0])
    except: pass

# Absolute path to the folder containing this script
ROOT = Path(os.path.dirname(os.path.abspath(__file__)))

MIME = {
    '.html':  'text/html; charset=utf-8',
    '.js':    'application/javascript; charset=utf-8',
    '.mjs':   'application/javascript; charset=utf-8',
    '.css':   'text/css; charset=utf-8',
    '.json':  'application/json; charset=utf-8',
    '.png':   'image/png',
    '.jpg':   'image/jpeg',
    '.jpeg':  'image/jpeg',
    '.gif':   'image/gif',
    '.svg':   'image/svg+xml',
    '.ico':   'image/x-icon',
    '.woff':  'font/woff',
    '.woff2': 'font/woff2',
    '.txt':   'text/plain; charset=utf-8',
    '.md':    'text/plain; charset=utf-8',
    '.map':   'application/json; charset=utf-8',
}

class Handler(BaseHTTPRequestHandler):

    def send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        # Strip query string and decode URL
        raw_path = urlparse(self.path).path
        # Percent-decode
        from urllib.parse import unquote
        raw_path = unquote(raw_path)

        # Ignore Chrome DevTools noise
        if raw_path.startswith('/.well-known'):
            self.send_response(204)
            self.end_headers()
            return

        # Resolve to filesystem path safely
        # Prevent directory traversal
        rel = raw_path.lstrip('/')
        file_path = (ROOT / rel).resolve()
        try:
            file_path.relative_to(ROOT)
        except ValueError:
            self.send_response(403)
            self.end_headers()
            return

        # If directory, serve index.html
        if file_path.is_dir():
            file_path = file_path / 'index.html'

        # SPA fallback — serve index.html for unknown paths
        if not file_path.exists():
            file_path = ROOT / 'index.html'

        if not file_path.exists():
            self.send_response(404)
            self.end_headers()
            return

        # Determine MIME type from extension — NO registry, NO mimetypes module
        suffix = file_path.suffix.lower()
        content_type = MIME.get(suffix, 'application/octet-stream')

        try:
            data = file_path.read_bytes()
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_cors()
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        # Suppress the DevTools 404 noise
        msg = fmt % args
        if '.well-known' in msg:
            return
        print(f'  {self.address_string()} — {msg}')


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return '127.0.0.1'

print(f'\n🎮  Game Tracker  →  http://localhost:{PORT}')
print(f'    Press Ctrl+C to stop\n')

try:
    HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
except KeyboardInterrupt:
    print('\nServer stopped.')
