import sqlite3
import urllib.request
import urllib.error
import threading
import queue
import time
import os
import re
import base64
from datetime import datetime

DB_NAME = "archive.db"
THREADS = 8

CDN_DOMAINS = [
    'cdn.fenrid.com',
    'static.klipy.com',
    'media.klipy.com',
    'cdn.mezon.ai',
]

KLIPY_PROXY_RE = re.compile(r'https?://cdn\.fenrid\.com/external/klipy/([A-Za-z0-9+/=_-]+)(\.gif|\.webp|\.mp4)?(\?.*)?$')

def decode_klipy_url(url):
    m = KLIPY_PROXY_RE.match(url)
    if not m:
        return None
    b64 = m.group(1)
    # url-safe base64 → standard
    b64 = b64.replace('-', '+').replace('_', '/')
    padding = 4 - len(b64) % 4
    if padding != 4:
        b64 += '=' * padding
    try:
        return base64.b64decode(b64).decode('utf-8')
    except Exception:
        return None

def load_cookies():
    cookies = {}
    files = {
        'fenrid_client_device': 'cookie_device.txt',
        'fenrid_auth_cookie_scope_v2': 'cookie_scope.txt',
        'sb-uoglikzeqdosbmhwmyfm-auth-token.0': 'cookie_token0.txt',
        'sb-uoglikzeqdosbmhwmyfm-auth-token.1': 'cookie_token1.txt',
    }
    for name, fname in files.items():
        if os.path.exists(fname):
            val = open(fname).read().strip()
            if val:
                cookies[name] = val
    if not cookies:
        print("Warning: no cookie files found — CDN downloads may 403")
    else:
        print(f"Loaded {len(cookies)} cookies")
    return '; '.join(f'{k}={v}' for k, v in cookies.items())

def get_db():
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn

def format_bytes(b):
    for unit in ['B','KB','MB','GB']:
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"

def collect_urls(conn):
    urls = set()
    c = conn.cursor()

    c.execute("SELECT url, mime_type FROM attachments WHERE url != ''")
    for row in c.fetchall():
        if row[0]:
            urls.add((row[0], row[1] or ''))

    c.execute("SELECT avatar_url FROM users WHERE avatar_url != '' AND avatar_url IS NOT NULL")
    for row in c.fetchall():
        urls.add((row[0], 'image/webp'))

    c.execute("SELECT banner_url FROM users WHERE banner_url != '' AND banner_url IS NOT NULL")
    for row in c.fetchall():
        urls.add((row[0], 'image/webp'))

    c.execute("SELECT icon_url FROM servers WHERE icon_url != '' AND icon_url IS NOT NULL")
    for row in c.fetchall():
        urls.add((row[0], 'image/webp'))

    c.execute("SELECT url FROM emojis WHERE url != '' AND url IS NOT NULL")
    for row in c.fetchall():
        urls.add((row[0], 'image/webp'))

    pattern = re.compile(r'https?://(' + '|'.join(re.escape(d) for d in CDN_DOMAINS) + r')/[^\s\'"<>)]+')
    c.execute("SELECT content FROM messages WHERE content != ''")
    for row in c.fetchall():
        for match in pattern.finditer(row[0]):
            u = match.group(0).rstrip('.,;!?')
            urls.add((u, ''))

    c.execute("SELECT url FROM assets")
    done = {row[0] for row in c.fetchall()}

    return [(u, m) for u, m in urls if u and u not in done]

def fetch_url(url, cookie):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0',
        'Referer': 'https://fenrid.com/',
    }
    if cookie:
        headers['Cookie'] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read(), r.headers.get('content-type', '').split(';')[0].strip()

def download_worker(q, db_lock, conn, stats, cookie):
    while True:
        item = q.get()
        if item is None:
            break
        url, mime = item
        try:
            data, ct = None, mime or 'application/octet-stream'

            # try original URL first
            try:
                data, ct = fetch_url(url, cookie)
            except urllib.error.HTTPError as e:
                if e.code == 403:
                    # try decoding klipy proxy URL and fetching direct
                    direct = decode_klipy_url(url)
                    if direct:
                        try:
                            data, ct = fetch_url(direct, None)
                        except Exception:
                            pass
                if data is None:
                    raise

            if not ct:
                ct = mime or 'application/octet-stream'
            filename = url.split('/')[-1].split('?')[0]

            with db_lock:
                conn.execute(
                    "INSERT OR REPLACE INTO assets (url, filename, mime_type, size, data, downloaded_at) VALUES (?,?,?,?,?,?)",
                    (url, filename, ct, len(data), data, datetime.utcnow().isoformat())
                )
                conn.commit()
            with stats['lock']:
                stats['done'] += 1
                stats['bytes'] += len(data)

        except Exception as e:
            with stats['lock']:
                stats['failed'] += 1
                stats['errors'].append(f"{url}: {e}")
        finally:
            q.task_done()

def download_all():
    if not os.path.exists(DB_NAME):
        print(f"No {DB_NAME} found. Run har-converter.py first.")
        return

    cookie = load_cookies()
    conn = get_db()
    print("Collecting URLs to download...")
    urls = collect_urls(conn)
    total = len(urls)
    print(f"Found {total} assets to download ({THREADS} threads)")

    if total == 0:
        print("Nothing to download.")
        conn.close()
        return

    q = queue.Queue(maxsize=THREADS * 4)
    db_lock = threading.Lock()
    stats = {'done': 0, 'failed': 0, 'bytes': 0, 'errors': [], 'lock': threading.Lock()}

    workers = []
    for _ in range(THREADS):
        t = threading.Thread(target=download_worker, args=(q, db_lock, conn, stats, cookie), daemon=True)
        t.start()
        workers.append(t)

    start = time.time()
    for item in urls:
        q.put(item)

    def progress():
        while not q.empty() or stats['done'] + stats['failed'] < total:
            with stats['lock']:
                done = stats['done']
                failed = stats['failed']
                total_bytes = stats['bytes']
            elapsed = time.time() - start
            rate = done / elapsed if elapsed > 0 else 0
            eta = (total - done - failed) / rate if rate > 0 else 0
            print(f"\r  {done}/{total} done | {failed} failed | {format_bytes(total_bytes)} | {rate:.1f}/s | ETA {eta:.0f}s   ", end='', flush=True)
            time.sleep(1)

    pt = threading.Thread(target=progress, daemon=True)
    pt.start()

    q.join()
    for _ in workers:
        q.put(None)
    for w in workers:
        w.join()

    print()
    elapsed = time.time() - start
    with stats['lock']:
        print(f"\nDone in {elapsed:.1f}s")
        print(f"  Downloaded: {stats['done']} files ({format_bytes(stats['bytes'])})")
        print(f"  Failed: {stats['failed']}")
        if stats['errors'][:5]:
            print("  First errors:")
            for e in stats['errors'][:5]:
                print(f"    {e}")

    conn.close()

if __name__ == "__main__":
    download_all()