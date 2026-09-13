import sqlite3
import re
from flask import Flask, request, render_template_string, Response

app = Flask(__name__)
DB_NAME = "archive.db"

HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Fenrid Archive</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "gg sans", "Noto Sans", sans-serif; background: #313338; color: #dbdee1; height: 100vh; display: flex; overflow: hidden; font-size: 15px; }

#servers { width: 72px; background: #1e1f22; display: flex; flex-direction: column; align-items: center; padding: 8px 0; gap: 8px; overflow-y: auto; flex-shrink: 0; }
.server-icon { width: 48px; height: 48px; border-radius: 50%; background: #36393f; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 11px; font-weight: 700; color: #dbdee1; text-decoration: none; transition: border-radius .15s; overflow: hidden; flex-shrink: 0; }
.server-icon:hover, .server-icon.active { border-radius: 16px; background: #5865f2; color: #fff; }
.server-icon img { width: 100%; height: 100%; object-fit: cover; }
.server-abbr { text-align: center; line-height: 1.2; padding: 4px; }

#channels { width: 240px; background: #2b2d31; display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
#channels-header { padding: 16px; font-weight: 700; font-size: 15px; color: #f2f3f5; border-bottom: 1px solid #1e1f22; flex-shrink: 0; }
#channels-list { flex: 1; overflow-y: auto; padding: 8px; }
.channel-category { font-size: 11px; font-weight: 700; color: #8d9096; text-transform: uppercase; letter-spacing: .02em; padding: 16px 8px 4px; }
.channel-link { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 4px; color: #8d9096; text-decoration: none; font-size: 15px; }
.channel-link:hover { background: #35373c; color: #dbdee1; }
.channel-link.active { background: #404249; color: #f2f3f5; font-weight: 500; }
.ch-hash { color: #80848e; font-size: 18px; }

#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
#topbar { background: #313338; border-bottom: 1px solid #1e1f22; padding: 12px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
#topbar-title { font-weight: 700; font-size: 16px; color: #f2f3f5; }
#topbar-sub { color: #80848e; font-size: 14px; }

#searchbar { padding: 10px 16px; background: #313338; border-bottom: 1px solid #1e1f22; flex-shrink: 0; display: flex; gap: 8px; align-items: center; }
#searchbar form { display: flex; gap: 8px; flex: 1; }
#searchbar input { flex: 1; background: #1e1f22; border: none; border-radius: 4px; padding: 8px 12px; color: #dbdee1; font-size: 14px; outline: none; }
#searchbar input:focus { box-shadow: 0 0 0 2px #5865f2; }
#searchbar button { background: #5865f2; border: none; border-radius: 4px; color: #fff; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
#searchbar button:hover { background: #4752c4; }
.filter-btn { background: #2b2d31; border: 1px solid #3f4147; border-radius: 4px; color: #b5bac1; padding: 6px 10px; font-size: 13px; cursor: pointer; text-decoration: none; white-space: nowrap; }
.filter-btn:hover, .filter-btn.active { background: #404249; color: #fff; }

#stats { display: flex; gap: 8px; padding: 6px 16px; background: #2b2d31; border-bottom: 1px solid #1e1f22; flex-shrink: 0; flex-wrap: wrap; }
.stat { background: #1e1f22; border-radius: 4px; padding: 4px 10px; font-size: 12px; color: #80848e; }
.stat strong { color: #dbdee1; }

#messages { flex: 1; overflow-y: auto; padding: 8px 0 24px; }
.msg { display: flex; gap: 16px; padding: 2px 16px; position: relative; }
.msg:hover { background: #2e3035; }
.msg.first-in-group { padding-top: 16px; margin-top: 4px; }
.msg-avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; object-fit: cover; cursor: pointer; }
.msg-avatar-placeholder { width: 40px; height: 40px; border-radius: 50%; background: #5865f2; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; color: #fff; flex-shrink: 0; margin-top: 2px; cursor: pointer; }
.msg-no-avatar { width: 40px; flex-shrink: 0; }
.msg-body { flex: 1; min-width: 0; }
.msg-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; flex-wrap: wrap; }
.msg-author { font-weight: 600; font-size: 15px; color: #f2f3f5; cursor: pointer; text-decoration: none; }
.msg-author:hover { text-decoration: underline; }
.msg-author.bot::after { content: 'BOT'; background: #5865f2; color: #fff; font-size: 10px; font-weight: 700; padding: 1px 4px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }
.msg-author.staff::after { content: 'STAFF'; background: #ed4245; color: #fff; font-size: 10px; font-weight: 700; padding: 1px 4px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }
.msg-display { color: #80848e; font-size: 13px; }
.msg-time { color: #80848e; font-size: 12px; }
.msg-content { color: #dbdee1; line-height: 1.375; word-wrap: break-word; white-space: pre-wrap; }
.msg-content.deleted { color: #80848e; font-style: italic; }
.msg-edited { color: #80848e; font-size: 10px; margin-left: 4px; }
.msg-ping { background: rgba(88,101,242,.3); color: #c9cdfb; border-radius: 3px; padding: 0 2px; font-weight: 500; cursor: pointer; }
.msg-ping:hover { background: rgba(88,101,242,.6); }
.msg-pinned { color: #faa61a; font-size: 12px; margin-left: 4px; }

.msg-ref { border-left: 2px solid #4e5058; padding: 2px 8px; margin-bottom: 4px; color: #80848e; font-size: 13px; display: flex; gap: 6px; align-items: center; }
.msg-ref-avatar { width: 16px; height: 16px; border-radius: 50%; }
.msg-ref-author { color: #dbdee1; font-weight: 600; font-size: 13px; }

.attachments { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.att-image { max-width: 400px; max-height: 300px; border-radius: 4px; cursor: zoom-in; display: block; object-fit: contain; background: #1e1f22; }
.att-image:hover { opacity: 0.92; }
.att-file { background: #2b2d31; border: 1px solid #1e1f22; border-radius: 8px; padding: 10px 14px; display: flex; align-items: center; gap: 10px; max-width: 420px; }
.att-icon { font-size: 28px; flex-shrink: 0; }
.att-info { min-width: 0; flex: 1; }
.att-name { color: #00a8fc; font-size: 14px; word-break: break-all; text-decoration: none; }
.att-name:hover { text-decoration: underline; }
.att-size { color: #80848e; font-size: 12px; margin-top: 2px; }
.att-video { max-width: 400px; max-height: 300px; border-radius: 4px; display: block; }
.att-audio { margin-top: 4px; width: 280px; }

.reactions-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.reaction { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 2px 8px; font-size: 14px; display: flex; align-items: center; gap: 4px; }
.reaction-count { color: #dbdee1; font-size: 13px; font-weight: 600; }

#users { width: 220px; background: #2b2d31; display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
#users-header { padding: 12px 16px 4px; font-size: 11px; font-weight: 700; color: #8d9096; text-transform: uppercase; letter-spacing: .02em; flex-shrink: 0; }
#users-list { flex: 1; overflow-y: auto; padding: 4px 8px 8px; }
.user-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; color: #8d9096; text-decoration: none; }
.user-item:hover { background: #35373c; color: #dbdee1; }
.user-item.active { background: #404249; color: #f2f3f5; }
.user-avatar-sm { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; object-fit: cover; }
.user-avatar-placeholder { width: 32px; height: 32px; border-radius: 50%; background: #5865f2; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: #fff; flex-shrink: 0; }
.user-name { font-size: 14px; color: #dbdee1; font-weight: 500; }
.user-sub { font-size: 12px; color: #80848e; }

.empty { text-align: center; color: #80848e; padding: 60px 20px; }
.empty-icon { font-size: 48px; margin-bottom: 12px; }
.empty-text { font-size: 16px; font-weight: 600; color: #dbdee1; margin-bottom: 4px; }

::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #1a1b1e; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: #111214; }

#modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.9); z-index: 1000; align-items: center; justify-content: center; flex-direction: column; gap: 12px; }
#modal.open { display: flex; }
#modal img { max-width: 90vw; max-height: 85vh; border-radius: 4px; object-fit: contain; }
#modal-filename { color: #dbdee1; font-size: 13px; opacity: 0.7; }
#modal-close { position: fixed; top: 12px; right: 16px; color: #dbdee1; font-size: 36px; cursor: pointer; line-height: 1; opacity: 0.7; }
#modal-close:hover { opacity: 1; }
#modal-dl { color: #00a8fc; font-size: 13px; text-decoration: none; }
#modal-dl:hover { text-decoration: underline; }
</style>
</head>
<body>

<div id="servers">
{% for s in servers_list %}
<a class="server-icon {% if current_server == s.server_id %}active{% endif %}"
   href="/?server={{ s.server_id }}" title="{{ s.server_name }}">
  {% if s.icon_url %}
    <img src="/asset?url={{ s.icon_url | urlencode }}" alt="{{ s.server_name }}"
         onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
    <span class="server-abbr" style="display:none">{{ s.server_name[:2].upper() }}</span>
  {% else %}
    <span class="server-abbr">{{ s.server_name[:2].upper() }}</span>
  {% endif %}
</a>
{% endfor %}
</div>

<div id="channels">
  <div id="channels-header">{{ current_server_name or 'Select a server' }}</div>
  <div id="channels-list">
    {% set ns = namespace(last_parent=None) %}
    {% for ch in channels_list %}
      {% if ch.parent_name and ch.parent_name != ns.last_parent %}
        <div class="channel-category">{{ ch.parent_name }}</div>
        {% set ns.last_parent = ch.parent_name %}
      {% endif %}
      <a class="channel-link {% if current_channel == ch.channel_id %}active{% endif %}"
         href="/?server={{ current_server }}&channel={{ ch.channel_id }}">
        <span class="ch-hash">#</span>{{ ch.channel_name }}
      </a>
    {% endfor %}
  </div>
</div>

<div id="main">
  <div id="topbar">
    <span class="ch-hash" style="font-size:20px;color:#80848e">#</span>
    <span id="topbar-title">{{ current_channel_name or 'Fenrid Archive' }}</span>
    <span id="topbar-sub">{{ result_count }} messages</span>
    {% if pinned_count %}<a class="filter-btn {% if show_pinned %}active{% endif %}"
       href="/?server={{ current_server }}&channel={{ current_channel }}&pinned=1">📌 {{ pinned_count }} pinned</a>{% endif %}
  </div>

  <div id="searchbar">
    <form method="GET">
      <input type="hidden" name="server" value="{{ current_server or '' }}">
      <input type="hidden" name="channel" value="{{ current_channel or '' }}">
      <input type="text" name="q" value="{{ query or '' }}" placeholder="Search messages, @username, or paste a message ID...">
      <button type="submit">Search</button>
    </form>
    {% if query %}
    <a class="filter-btn" href="/?server={{ current_server }}&channel={{ current_channel }}">✕ Clear</a>
    {% endif %}
  </div>

  <div id="stats">
    <span class="stat">💬 <strong>{{ global_stats.messages }}</strong> messages</span>
    <span class="stat">👤 <strong>{{ global_stats.users }}</strong> users</span>
    <span class="stat">📎 <strong>{{ global_stats.attachments }}</strong> attachments</span>
    <span class="stat">🖼 <strong>{{ global_stats.assets }}</strong> assets cached</span>
    <span class="stat">🏠 <strong>{{ global_stats.servers }}</strong> servers</span>
    {% if global_stats.unresolved > 0 %}
    <span class="stat" style="color:#faa61a">⚠ <strong>{{ global_stats.unresolved }}</strong> unresolved</span>
    {% endif %}
  </div>

  <div id="messages">
    {% if not messages %}
    <div class="empty">
      <div class="empty-icon">{% if current_channel %}🔍{% else %}👈{% endif %}</div>
      <div class="empty-text">{% if current_channel %}No messages found{% if query %} for "{{ query }}"{% endif %}{% else %}Select a server and channel{% endif %}</div>
    </div>
    {% endif %}

    {% set ns = namespace(prev_author=None, prev_ts=None) %}
    {% for msg in messages %}
      {% set gap = ns.prev_author != msg.author_id or msg.time_gap %}
      <div class="msg {% if gap %}first-in-group{% endif %}" id="msg-{{ msg.id }}">
        {% if gap %}
          {% if msg.avatar_url %}
            <img class="msg-avatar" src="/asset?url={{ msg.avatar_url | urlencode }}"
                 alt="{{ msg.username }}"
                 onerror="this.outerHTML='<div class=msg-avatar-placeholder>{{ (msg.display_name or msg.username or '?')[0].upper() }}</div>'"
                 onclick="filterUser('{{ msg.username }}')">
          {% else %}
            <div class="msg-avatar-placeholder" onclick="filterUser('{{ msg.username }}')">{{ (msg.display_name or msg.username or '?')[0].upper() }}</div>
          {% endif %}
        {% else %}
          <div class="msg-no-avatar">
            <span style="position:absolute;left:28px;font-size:11px;color:#4e5058;line-height:22px">{{ msg.short_time }}</span>
          </div>
        {% endif %}

        <div class="msg-body">
          {% if gap %}
          <div class="msg-header">
            <a class="msg-author {% if msg.bot %}bot{% elif msg.is_staff %}staff{% endif %}"
               href="/?server={{ current_server }}&channel={{ current_channel }}&q=@{{ msg.username }}">
              {{ msg.display_name or msg.username or 'Unknown' }}
            </a>
            {% if msg.display_name and msg.display_name != msg.username %}
            <span class="msg-display">@{{ msg.username }}</span>
            {% endif %}
            <span class="msg-time">{{ msg.created_at }}</span>
            {% if msg.pinned %}<span class="msg-pinned">📌</span>{% endif %}
          </div>
          {% endif %}

          {% if msg.ref_content %}
          <div class="msg-ref">
            {% if msg.ref_avatar %}
            <img class="msg-ref-avatar" src="/asset?url={{ msg.ref_avatar | urlencode }}"
                 onerror="this.style.display='none'" alt="">
            {% endif %}
            <span class="msg-ref-author">{{ msg.ref_author or 'Unknown' }}</span>
            <span>{{ msg.ref_content[:120] }}{% if msg.ref_content | length > 120 %}...{% endif %}</span>
          </div>
          {% endif %}

          {% if msg.content or msg.deleted_at %}
          <div class="msg-content {% if msg.deleted_at %}deleted{% endif %}">{{ msg.clean_content | safe }}{% if msg.deleted_at %} <em>[deleted]</em>{% endif %}{% if msg.edited_at %}<span class="msg-edited">(edited)</span>{% endif %}</div>
          {% endif %}

          {% if msg.attachments %}
          <div class="attachments">
            {% for att in msg.attachments %}
              {% set asset_url = '/asset?url=' + (att.url | urlencode) %}
              {% if att.mime_type and att.mime_type.startswith('image/') %}
                <img class="att-image" src="{{ asset_url }}" alt="{{ att.name }}"
                     loading="lazy"
                     onclick="openModal('{{ asset_url }}','{{ att.name }}','{{ att.url }}')"
                     onerror="this.src='{{ att.url }}'">
              {% elif att.mime_type and att.mime_type.startswith('video/') %}
                <video class="att-video" controls preload="none">
                  <source src="{{ asset_url }}" type="{{ att.mime_type }}"
                          onerror="this.src='{{ att.url }}'">
                </video>
              {% elif att.mime_type and att.mime_type.startswith('audio/') %}
                <div class="att-file">
                  <span class="att-icon">🎵</span>
                  <div class="att-info">
                    <div>{{ att.name }}</div>
                    <audio class="att-audio" controls preload="none">
                      <source src="{{ asset_url }}">
                    </audio>
                  </div>
                </div>
              {% else %}
                <div class="att-file">
                  <span class="att-icon">{% if att.mime_type and 'pdf' in att.mime_type %}📄{% elif att.name and att.name.endswith('.xpi') %}🧩{% else %}📎{% endif %}</span>
                  <div class="att-info">
                    <a class="att-name" href="{{ asset_url }}" download="{{ att.name }}" target="_blank">{{ att.name }}</a>
                    {% if att.size %}<div class="att-size">{{ (att.size / 1024) | round(1) }} KB</div>{% endif %}
                  </div>
                </div>
              {% endif %}
            {% endfor %}
          </div>
          {% endif %}

          {% if msg.reactions %}
          <div class="reactions-row">
            {% for rxn in msg.reactions %}
            <div class="reaction">{{ rxn.emoji }} <span class="reaction-count">{{ rxn.count }}</span></div>
            {% endfor %}
          </div>
          {% endif %}

        </div>
      </div>
      {% set ns.prev_author = msg.author_id %}
    {% endfor %}
  </div>
</div>

<div id="users">
  <div id="users-header">Members — {{ users_list | length }}</div>
  <div id="users-list">
    {% for u in users_list %}
    <a class="user-item {% if query == '@' + u.username %}active{% endif %}"
       href="/?server={{ current_server }}&channel={{ current_channel }}&q=@{{ u.username }}">
      {% if u.avatar_url %}
        <img class="user-avatar-sm" src="/asset?url={{ u.avatar_url | urlencode }}" alt="{{ u.username }}"
             onerror="this.outerHTML='<div class=user-avatar-placeholder>{{ (u.display_name or u.username or u.user_id)[0].upper() }}</div>'">
      {% else %}
        <div class="user-avatar-placeholder">{{ (u.display_name or u.username or '?')[0].upper() }}</div>
      {% endif %}
      <div>
        <div class="user-name">{{ u.display_name or u.username }}</div>
        {% if u.display_name and u.display_name != u.username %}
        <div class="user-sub">@{{ u.username }}</div>
        {% endif %}
      </div>
    </a>
    {% endfor %}
  </div>
</div>

<div id="modal" onclick="closeModal(event)">
  <span id="modal-close" onclick="closeModal()">×</span>
  <img id="modal-img" src="" alt="">
  <div style="display:flex;gap:16px;align-items:center">
    <span id="modal-filename"></span>
    <a id="modal-dl" href="#" download>⬇ Download</a>
  </div>
</div>

<script>
function openModal(src, name, orig) {
  document.getElementById('modal-img').src = src;
  document.getElementById('modal-filename').textContent = name || '';
  const dl = document.getElementById('modal-dl');
  dl.href = src; dl.download = name || 'image';
  document.getElementById('modal').classList.add('open');
}
function closeModal(e) {
  if (!e || e.target === document.getElementById('modal') || e.target.id === 'modal-close')
    document.getElementById('modal').classList.remove('open');
}
document.addEventListener('keydown', e => { if(e.key==='Escape') document.getElementById('modal').classList.remove('open'); });
function filterUser(username) {
  const url = new URL(location.href);
  url.searchParams.set('q', '@' + username);
  location.href = url;
}
</script>
</body>
</html>"""


def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def get_global_stats():
    conn = get_db()
    c = conn.cursor()
    stats = {}
    for key, sql in [
        ('messages', "SELECT COUNT(*) FROM messages"),
        ('users', "SELECT COUNT(*) FROM users"),
        ('attachments', "SELECT COUNT(*) FROM attachments"),
        ('assets', "SELECT COUNT(*) FROM assets"),
        ('servers', "SELECT COUNT(*) FROM servers"),
    ]:
        try:
            c.execute(sql)
            stats[key] = c.fetchone()[0]
        except Exception:
            stats[key] = 0
    try:
        c.execute("SELECT COUNT(DISTINCT author_id) FROM messages WHERE author_id NOT IN (SELECT user_id FROM users) AND author_id != 'Unknown'")
        stats['unresolved'] = c.fetchone()[0]
    except Exception:
        stats['unresolved'] = 0
    conn.close()
    return stats


def get_servers():
    conn = get_db()
    rows = conn.execute("SELECT server_id, server_name, icon_url FROM servers ORDER BY server_name").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_channels(server_id):
    conn = get_db()

    # get all channels including categories
    all_rows = conn.execute("""
        SELECT channel_id, COALESCE(channel_name, 'channel-'||channel_id) as channel_name,
               channel_type, position, parent_id
        FROM channels WHERE server_id=?
        ORDER BY position ASC
    """, (server_id,)).fetchall()

    if not all_rows:
        # fallback: infer from messages
        all_rows = conn.execute("""
            SELECT DISTINCT m.channel_id,
                   COALESCE(c.channel_name,'channel-'||m.channel_id) as channel_name,
                   0 as channel_type, 0 as position, NULL as parent_id
            FROM messages m LEFT JOIN channels c ON m.channel_id=c.channel_id
            WHERE m.server_id=? ORDER BY channel_name
        """, (server_id,)).fetchall()
        conn.close()
        return [dict(r) | {'parent_name': None} for r in all_rows]

    categories = {r['channel_id']: r for r in all_rows if r['channel_type'] == 4}
    channels = [r for r in all_rows if r['channel_type'] != 4]

    result = []
    for r in channels:
        d = dict(r)
        parent = categories.get(d.get('parent_id') or '')
        d['parent_name'] = parent['channel_name'] if parent else None
        d['parent_position'] = parent['position'] if parent else -1
        result.append(d)

    # sort: uncategorized first, then by parent position, then channel position
    result.sort(key=lambda x: (0 if x['parent_name'] is None else 1, x['parent_position'], x['position']))

    conn.close()
    return result


def get_users_for_server(server_id):
    conn = get_db()
    rows = conn.execute("""
        SELECT DISTINCT u.user_id, u.username, u.display_name, u.avatar_url
        FROM users u JOIN messages m ON m.author_id=u.user_id
        WHERE m.server_id=?
        ORDER BY LOWER(u.display_name), LOWER(u.username)
    """, (server_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_user_lookup(server_id):
    conn = get_db()
    rows = conn.execute("""
        SELECT DISTINCT u.user_id, u.username, u.avatar_url
        FROM users u JOIN messages m ON m.author_id=u.user_id
        WHERE m.server_id=?
    """, (server_id,)).fetchall()
    conn.close()
    return {r['user_id']: {'username': r['username'], 'avatar': r['avatar_url'] or ''} for r in rows}


def render_markdown(text):
    lines = text.split('\n')
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # headings
        if line.startswith('### '):
            out.append(f'<span style="font-size:15px;font-weight:700;color:#f2f3f5">{line[4:]}</span>')
        elif line.startswith('## '):
            out.append(f'<span style="font-size:17px;font-weight:700;color:#f2f3f5">{line[3:]}</span>')
        elif line.startswith('# '):
            out.append(f'<span style="font-size:20px;font-weight:700;color:#f2f3f5">{line[2:]}</span>')
        # bullet lists
        elif line.startswith('- ') or line.startswith('* '):
            out.append(f'<span style="display:block;padding-left:16px">• {line[2:]}</span>')
        elif re.match(r'^\d+\. ', line):
            out.append(f'<span style="display:block;padding-left:16px">{line}</span>')
        else:
            out.append(line)
        i += 1
    text = '\n'.join(out)
    # inline: bold, italic, strikethrough, inline code
    text = re.sub(r'\*\*\*(.+?)\*\*\*', r'<strong><em>\1</em></strong>', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'__(.+?)__', r'<strong>\1</strong>', text)
    text = re.sub(r'\*(.+?)\*', r'<em>\1</em>', text)
    text = re.sub(r'_(.+?)_', r'<em>\1</em>', text)
    text = re.sub(r'~~(.+?)~~', r'<span style="text-decoration:line-through">\1</span>', text)
    text = re.sub(r'`([^`]+)`', r'<code style="background:#2b2d31;padding:2px 4px;border-radius:3px;font-size:13px;font-family:monospace">\1</code>', text)
    # links
    text = re.sub(r'\[([^\]]+)\]\((https?://[^\)]+)\)', r'<a href="\2" target="_blank" style="color:#00a8fc">\1</a>', text)
    text = re.sub(r'(?<!["\(])(https?://[^\s<>"]+)', r'<a href="\1" target="_blank" style="color:#00a8fc">\1</a>', text)
    return text


def clean_content(content, user_lookup):
    if not content:
        return ''
    def replace_ping(m):
        uid = m.group(1)
        info = user_lookup.get(uid, {})
        name = info.get('username', uid) if info else uid
        return f'\x00PING:{name}\x00'
    # escape html first
    content = content.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    # resolve pings before markdown (protect them)
    content = re.sub(r'&lt;@([^&]+)&gt;', replace_ping, content)
    # render markdown
    content = render_markdown(content)
    # restore pings
    content = re.sub(r'\x00PING:([^\x00]+)\x00', lambda m: f'<span class="msg-ping" onclick="filterUser(\'{m.group(1)}\'">@{m.group(1)}</span>', content)
    return content


def get_messages(channel_id, server_id, query=None, pinned_only=False, limit=500):
    conn = get_db()
    user_lookup = get_user_lookup(server_id) if server_id else {}

    base = """
        SELECT m.id, m.created_at, m.edited_at, m.deleted_at, m.author_id,
               m.content, m.type, m.pinned, m.reference_id,
               u.username, u.display_name, u.avatar_url, u.bot, u.is_staff,
               rm.content as ref_content, ru.username as ref_author, ru.avatar_url as ref_avatar
        FROM messages m
        LEFT JOIN users u ON m.author_id=u.user_id
        LEFT JOIN messages rm ON m.reference_id=rm.id
        LEFT JOIN users ru ON rm.author_id=ru.user_id
        WHERE m.channel_id=?
    """
    params = [channel_id]

    if pinned_only:
        base += " AND m.pinned=1"
    elif query:
        if query.startswith('@'):
            uname = query[1:]
            base += " AND (u.username=? OR u.display_name=?)"
            params += [uname, uname]
        else:
            base += " AND (m.content LIKE ? OR m.id=?)"
            params += [f'%{query}%', query]

    base += " ORDER BY m.created_at ASC LIMIT ?"
    params.append(limit)

    rows = conn.execute(base, params).fetchall()

    msg_ids = [r['id'] for r in rows]
    att_map = {}
    rxn_map = {}
    if msg_ids:
        ph = ','.join('?' * len(msg_ids))
        for att in conn.execute(f"SELECT * FROM attachments WHERE message_id IN ({ph})", msg_ids).fetchall():
            att_map.setdefault(att['message_id'], []).append(dict(att))
        for rxn in conn.execute(f"SELECT message_id, emoji, count FROM reactions WHERE message_id IN ({ph})", msg_ids).fetchall():
            rxn_map.setdefault(rxn['message_id'], []).append(dict(rxn))

    conn.close()

    result = []
    prev_author = None
    prev_ts = None

    for row in rows:
        r = dict(row)
        r['clean_content'] = clean_content(r.get('content') or '', user_lookup)
        r['attachments'] = att_map.get(r['id'], [])
        r['reactions'] = rxn_map.get(r['id'], [])

        time_gap = True
        if prev_author == r['author_id'] and prev_ts and r.get('created_at'):
            try:
                from datetime import datetime as dt
                t1 = dt.fromisoformat(prev_ts)
                t2 = dt.fromisoformat(r['created_at'])
                time_gap = (t2 - t1).total_seconds() > 300
            except Exception:
                pass

        r['time_gap'] = time_gap

        try:
            from datetime import datetime as dt
            t = dt.fromisoformat(r['created_at'])
            r['short_time'] = t.strftime('%H:%M')
        except Exception:
            r['short_time'] = ''

        prev_author = r['author_id']
        prev_ts = r.get('created_at')
        result.append(r)

    return result


@app.route('/asset')
def serve_asset():
    url = request.args.get('url', '')
    if not url:
        return '', 404

    conn = get_db()
    row = conn.execute("SELECT data, mime_type, filename FROM assets WHERE url=?", (url,)).fetchone()
    conn.close()

    if row and row['data']:
        return Response(
            row['data'],
            mimetype=row['mime_type'] or 'application/octet-stream',
            headers={'Cache-Control': 'public, max-age=31536000'}
        )

    # fallback: redirect to original URL
    from flask import redirect
    return redirect(url)


@app.route('/')
def index():
    server_id = request.args.get('server', '')
    channel_id = request.args.get('channel', '')
    query = request.args.get('q', '').strip()
    show_pinned = request.args.get('pinned') == '1'

    servers_list = get_servers()
    channels_list = get_channels(server_id) if server_id else []
    users_list = get_users_for_server(server_id) if server_id else []
    global_stats = get_global_stats()

    current_server_name = next((s['server_name'] for s in servers_list if s['server_id'] == server_id), '')
    current_channel_name = next((c['channel_name'] for c in channels_list if c['channel_id'] == channel_id), '')

    messages = []
    pinned_count = 0
    if channel_id:
        if show_pinned:
            messages = get_messages(channel_id, server_id, pinned_only=True)
        else:
            messages = get_messages(channel_id, server_id, query or None)
        conn = get_db()
        row = conn.execute("SELECT COUNT(*) FROM messages WHERE channel_id=? AND pinned=1", (channel_id,)).fetchone()
        pinned_count = row[0] if row else 0
        conn.close()

    return render_template_string(
        HTML,
        servers_list=servers_list,
        channels_list=channels_list,
        users_list=users_list,
        global_stats=global_stats,
        messages=messages,
        result_count=len(messages),
        current_server=server_id,
        current_channel=channel_id,
        current_server_name=current_server_name,
        current_channel_name=current_channel_name,
        query=query,
        show_pinned=show_pinned,
        pinned_count=pinned_count,
    )


if __name__ == '__main__':
    app.run(debug=True, port=8080, threaded=True)