#!/usr/bin/env python3
"""
Game Tracker — Local dev server
Usage:
  python3 serve.py           — basic file server (localhost:8080)
  python3 serve.py 3000      — custom port
  python3 serve.py --sync    — enable LAN sync relay (for multi-device sync)

When --sync is active, other devices on your network can access the app at:
  http://YOUR_LOCAL_IP:8080
"""
import http.server, json, sys, os, threading
from urllib.parse import urlparse, parse_qs

PORT = 8080
SYNC = '--sync' in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith('--')]
if args:
    try: PORT = int(args[0])
    except: pass

MIME_TYPES = {
    '.js':    'application/javascript',
    '.mjs':   'application/javascript',
    '.css':   'text/css',
    '.html':  'text/html',
    '.json':  'application/json',
    '.png':   'image/png',
    '.jpg':   'image/jpeg',
    '.svg':   'image/svg+xml',
    '.ico':   'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff':  'font/woff',
}

# In-memory sync store (per-user payloads)
_sync_store = {}
_sync_lock  = threading.Lock()

class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(str(path))[1].lower()
        return MIME_TYPES.get(ext, super().guess_type(path))

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} — {fmt % args}")

    def do_GET(self):
        parsed = urlparse(self.path)
        if SYNC and parsed.path == '/sync/pull':
            qs   = parse_qs(parsed.query)
            user = (qs.get('user',[''])[0])
            with _sync_lock:
                payload = _sync_store.get(user)
            body = json.dumps({'payload': payload}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(body))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if SYNC and parsed.path == '/sync/push':
            length = int(self.headers.get('Content-Length', 0))
            data   = json.loads(self.rfile.read(length))
            user   = data.get('user','')
            if user:
                with _sync_lock:
                    _sync_store[user] = data.get('payload')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        self.send_response(405)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Get local IP for LAN display
def get_local_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return 'YOUR_IP'

host = '' if SYNC else '127.0.0.1'
print(f"\n🎮  Game Tracker running at http://localhost:{PORT}")
if SYNC:
    ip = get_local_ip()
    print(f"🔄  LAN sync enabled — other devices: http://{ip}:{PORT}")
print(f"    Press Ctrl+C to stop\n")

try:
    http.server.HTTPServer((host, PORT), Handler).serve_forever()
except KeyboardInterrupt:
    print("\nServer stopped.")
