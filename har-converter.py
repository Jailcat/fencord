import os
import json
import glob
import re
import sqlite3
from datetime import datetime

DB_NAME = "archive.db"

def init_database():
    conn = sqlite3.connect(DB_NAME)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    c = conn.cursor()
    c.executescript('''
        CREATE TABLE IF NOT EXISTS servers (
            server_id TEXT PRIMARY KEY,
            server_name TEXT DEFAULT 'Unknown Server',
            icon_url TEXT,
            description TEXT,
            owner_id TEXT
        );

        CREATE TABLE IF NOT EXISTS channels (
            channel_id TEXT PRIMARY KEY,
            channel_name TEXT DEFAULT 'unknown-channel',
            channel_type INTEGER DEFAULT 0,
            server_id TEXT,
            position INTEGER DEFAULT 0,
            parent_id TEXT,
            topic TEXT,
            FOREIGN KEY(server_id) REFERENCES servers(server_id)
        );

        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            display_name TEXT,
            avatar_url TEXT,
            banner_url TEXT,
            bio TEXT,
            bot INTEGER DEFAULT 0,
            is_staff INTEGER DEFAULT 0,
            premium_type INTEGER DEFAULT 0,
            badge_flags INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            edited_at TEXT,
            deleted_at TEXT,
            channel_id TEXT NOT NULL,
            server_id TEXT,
            author_id TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            type INTEGER DEFAULT 0,
            pinned INTEGER DEFAULT 0,
            reference_id TEXT,
            FOREIGN KEY(channel_id) REFERENCES channels(channel_id),
            FOREIGN KEY(author_id) REFERENCES users(user_id)
        );

        CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            url TEXT NOT NULL,
            name TEXT,
            size INTEGER,
            mime_type TEXT,
            width INTEGER,
            height INTEGER,
            sha256 TEXT,
            FOREIGN KEY(message_id) REFERENCES messages(id)
        );

        CREATE TABLE IF NOT EXISTS assets (
            url TEXT PRIMARY KEY,
            filename TEXT,
            mime_type TEXT,
            size INTEGER,
            data BLOB,
            downloaded_at TEXT
        );

        CREATE TABLE IF NOT EXISTS roles (
            role_id TEXT PRIMARY KEY,
            server_id TEXT,
            name TEXT,
            color INTEGER,
            position INTEGER,
            hoist INTEGER DEFAULT 0,
            permissions TEXT
        );

        CREATE TABLE IF NOT EXISTS emojis (
            emoji_id TEXT PRIMARY KEY,
            server_id TEXT,
            name TEXT,
            url TEXT,
            animated INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS reactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT,
            emoji TEXT,
            count INTEGER,
            FOREIGN KEY(message_id) REFERENCES messages(id)
        );

        CREATE TABLE IF NOT EXISTS invites (
            code TEXT PRIMARY KEY,
            server_id TEXT,
            channel_id TEXT,
            inviter_id TEXT,
            uses INTEGER,
            max_uses INTEGER,
            expires_at TEXT,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS pins (
            message_id TEXT PRIMARY KEY,
            channel_id TEXT,
            pinned_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel_id);
        CREATE INDEX IF NOT EXISTS idx_msg_author ON messages(author_id);
        CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_msg_server ON messages(server_id);
        CREATE INDEX IF NOT EXISTS idx_att_message ON attachments(message_id);
        CREATE INDEX IF NOT EXISTS idx_att_url ON attachments(url);
    ''')
    conn.commit()
    return conn


def parse_ts(val):
    if not val:
        return None
    try:
        return datetime.fromisoformat(str(val).replace('Z', '+00:00')).strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return str(val)


def extract_user(profile, uid=None):
    if not profile or not isinstance(profile, dict):
        return None
    user_id = str(uid or profile.get('id') or profile.get('profile_id') or profile.get('user_id') or '')
    if not user_id:
        return None
    username = profile.get('username') or ''
    if not username:
        return None
    display_name = profile.get('display_name') or ''
    assets = profile.get('assets') or {}
    avatar_asset = assets.get('avatar') or {}
    banner_asset = assets.get('banner') or {}
    avatar_url = profile.get('avatar') or ''
    if not avatar_url and isinstance(avatar_asset, dict) and avatar_asset.get('key'):
        ext = avatar_asset.get('ext', 'webp')
        avatar_url = f"https://cdn.fenrid.com/profiles/{user_id}/avatars/{avatar_asset['key']}.{ext}"
    banner_url = ''
    if isinstance(banner_asset, dict) and banner_asset.get('key'):
        ext = banner_asset.get('ext', 'webp')
        banner_url = f"https://cdn.fenrid.com/profiles/{user_id}/banners/{banner_asset['key']}.{ext}"
    return (
        user_id, username, display_name, avatar_url, banner_url,
        profile.get('bio') or '',
        1 if profile.get('bot') else 0,
        1 if profile.get('is_staff') else 0,
        profile.get('premium_type', 0),
        profile.get('badge_flags', 0),
    )


def process_all_har_files():
    print("=" * 60)
    print("FENRID HAR PIPELINE")
    print("=" * 60)

    har_files = glob.glob("*.har")
    if not har_files:
        print("No .har files found in current directory.")
        return

    print(f"Found {len(har_files)} HAR file(s). Initializing database...")
    conn = init_database()
    c = conn.cursor()

    messages = {}
    attachments = {}
    users = {}
    channels = {}
    servers = {}
    roles = {}
    emojis = {}
    reactions = []
    invites = {}
    pins = {}

    for har_path in har_files:
        print(f"\nProcessing: {os.path.basename(har_path)}")
        try:
            with open(har_path, 'r', encoding='utf-8', errors='ignore') as f:
                har = json.load(f)
        except Exception as e:
            print(f"  Failed to parse: {e}")
            continue

        entries = har.get('log', {}).get('entries', [])
        print(f"  {len(entries)} entries")

        for entry in entries:
            url = entry.get('request', {}).get('url', '')
            if 'fenrid.com' not in url and not url.startswith('/api/'):
                continue

            text = entry.get('response', {}).get('content', {}).get('text', '')
            if not text:
                continue

            try:
                data = json.loads(text)
            except Exception:
                continue

            # ── messages ──────────────────────────────────────────────
            if re.search(r'/api/chat/server/messages', url):
                msgs = data.get('messages', []) if isinstance(data, dict) else data
                if not isinstance(msgs, list):
                    continue
                for msg in msgs:
                    if not isinstance(msg, dict):
                        continue
                    mid = msg.get('id')
                    if not mid:
                        continue

                    author = msg.get('profiles') or msg.get('author') or {}
                    author_id = str(msg.get('author_id') or author.get('profile_id') or author.get('id') or 'Unknown')

                    u = extract_user(author, author_id)
                    if u and u[0] not in users:
                        users[u[0]] = u

                    for mp in (msg.get('mention_profiles') or []):
                        u2 = extract_user(mp)
                        if u2 and u2[0] not in users:
                            users[u2[0]] = u2

                    channel_id = str(msg.get('channel_id') or 'Unknown')
                    server_id = str(msg.get('server_id') or '')

                    ref = msg.get('message_reference')
                    ref_id = str(ref.get('message_id') or ref.get('id') or '') if isinstance(ref, dict) else None

                    messages[str(mid)] = (
                        str(mid),
                        parse_ts(msg.get('created_at')),
                        parse_ts(msg.get('edited_at')),
                        parse_ts(msg.get('deleted_at')),
                        channel_id,
                        server_id or None,
                        author_id,
                        msg.get('content') or '',
                        msg.get('type', 0),
                        1 if msg.get('pinned') else 0,
                        ref_id,
                    )

                    for att in (msg.get('attachments') or []):
                        att_url = att.get('url') or ''
                        att_id = str(msg.get('id')) + '_' + (att.get('name') or att_url.split('/')[-1])
                        attachments[att_id] = (
                            att_id, str(mid), att_url,
                            att.get('name'), att.get('size'),
                            att.get('type'), att.get('width'),
                            att.get('height'), att.get('sha256'),
                        )

                    for rxn in (msg.get('reactions') or []):
                        emoji = rxn.get('emoji') or rxn.get('name') or ''
                        count = rxn.get('count', 0)
                        reactions.append((str(mid), str(emoji), count))

            # ── server meta (scraped from DOM) ────────────────────────
            elif '/__meta/server/' in url:
                if isinstance(data, dict) and data.get('id'):
                    sid = str(data['id'])
                    servers[sid] = (
                        sid,
                        data.get('name') or 'Unknown Server',
                        data.get('icon') or '',
                        '', '',
                    )

            # ── server info ───────────────────────────────────────────
            elif re.search(r'/api/servers/([^/?]+)$', url):
                if not isinstance(data, dict):
                    continue
                sid = data.get('id') or re.search(r'/api/servers/([^/?]+)$', url).group(1)
                icon = data.get('icon') or ''
                if not icon:
                    icon_asset = (data.get('assets') or {}).get('icon') or {}
                    if isinstance(icon_asset, dict) and icon_asset.get('key'):
                        icon = f"https://cdn.fenrid.com/servers/{sid}/icons/{icon_asset['key']}.{icon_asset.get('ext','webp')}"
                servers[str(sid)] = (
                    str(sid),
                    data.get('name') or data.get('server_name') or 'Unknown Server',
                    icon,
                    data.get('description') or '',
                    str(data.get('owner_id') or ''),
                )

            # ── channels ──────────────────────────────────────────────
            elif re.search(r'/api/servers/([^/]+)/channels', url):
                m = re.search(r'/api/servers/([^/]+)/channels', url)
                sid = m.group(1) if m else None
                chans = data.get('channels', []) if isinstance(data, dict) else data
                if not isinstance(chans, list):
                    continue
                for ch in chans:
                    if not isinstance(ch, dict):
                        continue
                    cid = ch.get('id')
                    if cid:
                        channels[str(cid)] = (
                            str(cid), ch.get('name', ''), ch.get('type', 0),
                            sid, ch.get('position', 0), ch.get('parent_id'),
                            ch.get('topic') or '',
                        )

            # ── roles ─────────────────────────────────────────────────
            elif re.search(r'/api/servers/([^/]+)/roles', url):
                m = re.search(r'/api/servers/([^/]+)/roles', url)
                sid = m.group(1) if m else None
                role_list = data if isinstance(data, list) else data.get('roles', [])
                if not isinstance(role_list, list):
                    continue
                for r in role_list:
                    if isinstance(r, dict) and r.get('id'):
                        roles[str(r['id'])] = (
                            str(r['id']), sid, r.get('name', ''),
                            r.get('color', 0), r.get('position', 0),
                            1 if r.get('hoist') else 0,
                            r.get('permissions') or '',
                        )

            # ── members ───────────────────────────────────────────────
            elif re.search(r'/api/servers/([^/]+)/members', url):
                m = re.search(r'/api/servers/([^/]+)/members', url)
                sid = m.group(1) if m else None
                if sid and sid not in servers:
                    servers[sid] = (sid, 'Unknown Server', '', '', '')
                member_list = data.get('members', []) if isinstance(data, dict) else data
                if not isinstance(member_list, list):
                    continue
                for mem in member_list:
                    if not isinstance(mem, dict):
                        continue
                    profile = mem.get('profile') or {}
                    uid = str(mem.get('profile_id') or profile.get('id') or '')
                    if not uid or uid in users:
                        continue
                    u = extract_user({**mem, **profile}, uid)
                    if u:
                        users[u[0]] = u

            # ── emojis ────────────────────────────────────────────────
            elif re.search(r'/api/servers/([^/]+)/emojis', url):
                m = re.search(r'/api/servers/([^/]+)/emojis', url)
                sid = m.group(1) if m else None
                emoji_list = data.get('emojis', []) if isinstance(data, dict) else data
                if not isinstance(emoji_list, list):
                    continue
                for em in emoji_list:
                    if not isinstance(em, dict) or not em.get('id'):
                        continue
                    eid = str(em['id'])
                    url_em = f"https://cdn.fenrid.com/emojis/{eid}.{'gif' if em.get('animated') else 'webp'}"
                    emojis[eid] = (eid, sid, em.get('name', ''), url_em, 1 if em.get('animated') else 0)

            # ── invites ───────────────────────────────────────────────
            elif re.search(r'/api/servers/([^/]+)/invites', url):
                invite_list = data if isinstance(data, list) else data.get('invites', [])
                if not isinstance(invite_list, list):
                    continue
                for inv in invite_list:
                    if not isinstance(inv, dict) or not inv.get('code'):
                        continue
                    invites[inv['code']] = (
                        inv['code'],
                        str(inv.get('server_id') or ''),
                        str(inv.get('channel_id') or ''),
                        str(inv.get('inviter_id') or inv.get('creator_id') or ''),
                        inv.get('uses', 0), inv.get('max_uses', 0),
                        parse_ts(inv.get('expires_at')),
                        parse_ts(inv.get('created_at')),
                    )

            # ── pins ──────────────────────────────────────────────────
            elif re.search(r'/api/channels/([^/]+)/pins', url):
                m = re.search(r'/api/channels/([^/]+)/pins', url)
                cid = m.group(1) if m else None
                pin_list = data if isinstance(data, list) else data.get('pins', [])
                if not isinstance(pin_list, list):
                    continue
                for pin in pin_list:
                    if isinstance(pin, dict) and pin.get('id'):
                        pins[str(pin['id'])] = (str(pin['id']), cid, parse_ts(pin.get('created_at')))

            # ── me/users ──────────────────────────────────────────────
            elif re.search(r'/api/users/me$', url):
                if isinstance(data, dict):
                    u = extract_user(data, data.get('id') or data.get('profile_id'))
                    if u and u[0] not in users:
                        users[u[0]] = u


    # infer servers from messages
    for row in messages.values():
        sid = row[5]
        if sid and sid not in servers:
            servers[sid] = (sid, 'Unknown Server', '', '', '')

    print(f"\nExtracted:")
    print(f"  {len(messages)} messages")
    print(f"  {len(users)} users")
    print(f"  {len(channels)} channels")
    print(f"  {len(servers)} servers")
    print(f"  {len(attachments)} attachments")
    print(f"  {len(roles)} roles")
    print(f"  {len(emojis)} emojis")
    print(f"  {len(reactions)} reactions")
    print(f"  {len(invites)} invites")
    print(f"  {len(pins)} pins")

    print("\nWriting to database...")
    c.executemany("INSERT OR REPLACE INTO servers VALUES (?,?,?,?,?)", servers.values())
    c.executemany("INSERT OR REPLACE INTO users VALUES (?,?,?,?,?,?,?,?,?,?)", users.values())
    c.executemany("INSERT OR REPLACE INTO channels VALUES (?,?,?,?,?,?,?)", channels.values())
    c.executemany("INSERT OR REPLACE INTO roles VALUES (?,?,?,?,?,?,?)", roles.values())
    c.executemany("INSERT OR REPLACE INTO emojis VALUES (?,?,?,?,?)", emojis.values())
    c.executemany("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)", messages.values())
    c.executemany("INSERT OR IGNORE INTO attachments VALUES (?,?,?,?,?,?,?,?,?)", attachments.values())
    c.executemany("INSERT OR IGNORE INTO invites VALUES (?,?,?,?,?,?,?,?)", invites.values())
    c.executemany("INSERT OR IGNORE INTO pins VALUES (?,?,?)", pins.values())
    if reactions:
        c.executemany("INSERT INTO reactions (message_id, emoji, count) VALUES (?,?,?)", reactions)
    conn.commit()

    c.execute("SELECT COUNT(*) FROM messages"); total_msgs = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM users"); total_users = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM attachments"); total_att = c.fetchone()[0]
    c.execute("SELECT COUNT(DISTINCT author_id) FROM messages WHERE author_id NOT IN (SELECT user_id FROM users) AND author_id != 'Unknown'")
    unresolved = c.fetchone()[0]
    conn.close()

    print("=" * 60)
    print(f"Done. {total_msgs} messages | {total_users} users | {total_att} attachments")
    if unresolved:
        print(f"Warning: {unresolved} unresolved author IDs")
    print(f"Database: {os.path.abspath(DB_NAME)}")
    print("=" * 60)


if __name__ == "__main__":
    process_all_har_files()
