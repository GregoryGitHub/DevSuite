"""Servidor de desenvolvimento do app Notas no navegador: serve src/ sem cache HTTP (os ES
modules mudam a cada edição). Uso: python tools/serve_web.py [porta]  ->  http://localhost:5180/notes.html
Com os emuladores do Firebase (firebase emulators:start): http://localhost:5180/notes.html?emulador
"""
import functools
import http.server
import pathlib
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 5180
root = pathlib.Path(__file__).resolve().parent.parent / "src"
handler = functools.partial(NoCache, directory=str(root))
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
