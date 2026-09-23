#!/usr/bin/env python3
"""
全ページのスクリプト構成を「本番 (Supabase) 対応」の形に揃える。何度実行しても同じ結果になる。

  1. 共通ライブラリを決まった順で読み込む
       config → store → pricing-core → pricing → (i18n) → (api) → (photos) → backend → boot
  2. ページ固有の処理 (インライン <script> と lp.js / manage.js) を
       <script type="text/x-deferred"> に変える。
     js/boot.js が、サーバーからのデータ読み込み (本番) を待ってから順番に実行する。
     デモモード (config.js が未設定) では読み込み待ちなしで、これまでどおり即実行される。

使い方: python3 scripts/transform-script-tags.py
"""
import io
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
VER = '20260923'

# 共通ライブラリ (この順で並べる)。optional は元々読み込んでいたページだけに残す
CORE = [
    ('config.js', False),
    ('store.js', False),
    ('pricing-core.js', False),
    ('pricing.js', False),
    ('i18n.js', True),
    ('api.js', True),
    ('photos.js', True),
    ('backend.js', False),
]
CORE_NAMES = {n for n, _ in CORE} | {'boot.js'}
# 位置を動かさないライブラリ (DOM 部品・CDN)
KEEP_LIBS = {'partials.js', 'partials-public.js', 'crud.js', 'settings.js',
             'chart.umd.min.js', 'exceljs.min.js'}
# ページ処理として遅延実行する外部スクリプト
PAGE_SRC = {'lp.js', 'manage.js'}

TAG_RE = re.compile(r'<script\b([^>]*)>(.*?)</script>', re.S | re.I)
SRC_RE = re.compile(r'\bsrc\s*=\s*"([^"]+)"', re.I)
TYPE_RE = re.compile(r'\btype\s*=\s*"([^"]+)"', re.I)


def basename(src):
    return src.split('?')[0].split('/')[-1]


def transform(path: pathlib.Path) -> bool:
    html = io.open(path, encoding='utf-8').read()
    prefix = '../js/' if path.parent.name == 'manage' else 'js/'
    tags = list(TAG_RE.finditer(html))
    if not tags:
        return False

    # 最初のライブラリ位置 (それより前のインライン script = head の設定反映・安全策 は触らない)
    first_lib = None
    for m in tags:
        src = SRC_RE.search(m.group(1))
        if src and (basename(src.group(1)) in CORE_NAMES or basename(src.group(1)) in KEEP_LIBS):
            first_lib = m.start()
            break
    if first_lib is None:
        # ライブラリを1つも読んでいないページ (例: 管理ログイン) は <body> 以降を対象にする
        b = re.search(r'<body\b', html, re.I)
        if not b:
            return False
        first_lib = b.start()

    present = set()
    out = []
    pos = 0
    first_page_marker = None
    for m in tags:
        attrs, body = m.group(1), m.group(2)
        src_m = SRC_RE.search(attrs)
        type_m = TYPE_RE.search(attrs)
        name = basename(src_m.group(1)) if src_m else None
        out.append(html[pos:m.start()])
        pos = m.end()

        if m.start() < first_lib:
            out.append(m.group(0))
            continue
        if name in CORE_NAMES:
            present.add(name)
            # 後で共通ブロックとして入れ直すので、タグ直前のインデント・改行ごと消す
            out[-1] = re.sub(r'\n?[ \t]*$', '', out[-1])
            continue
        if name in KEEP_LIBS or (name and name not in PAGE_SRC):
            out.append(m.group(0))
            continue
        # ここから下はページ処理
        if first_page_marker is None:
            first_page_marker = len(out)
            out.append('@@CORE_BLOCK@@')
        if name in PAGE_SRC:
            out.append('<script type="text/x-deferred" data-src="%s"></script>' % src_m.group(1))
        elif type_m and type_m.group(1) == 'text/x-deferred':
            out.append(m.group(0))
        elif type_m and type_m.group(1) not in ('text/javascript', 'module'):
            out.append(m.group(0))  # JSON 等のデータブロックはそのまま
        else:
            out.append('<script type="text/x-deferred">%s</script>' % body)
    out.append(html[pos:])
    new = ''.join(out)

    lines = []
    for n, optional in CORE:
        if optional and n not in present:
            continue
        lines.append('<script src="%s%s?v=%s"></script>' % (prefix, n, VER))
    lines.append('<script src="%sboot.js?v=%s"></script>' % (prefix, VER))
    block = '\n  '.join(lines)

    if '@@CORE_BLOCK@@' in new:
        new = new.replace('@@CORE_BLOCK@@', block + '\n  ', 1)
    else:
        new = re.sub(r'</body>', '  ' + block + '\n</body>', new, count=1, flags=re.I)

    # 空白だけの行を詰める
    new = re.sub(r'\n[ \t]+\n', '\n\n', new)
    new = re.sub(r'\n{3,}', '\n\n', new)
    if new != html:
        io.open(path, 'w', encoding='utf-8').write(new)
        return True
    return False


if __name__ == '__main__':
    changed = []
    for p in sorted(list(ROOT.glob('*.html')) + list((ROOT / 'manage').glob('*.html'))):
        if transform(p):
            changed.append(p.relative_to(ROOT))
    print('updated %d files' % len(changed))
    for c in changed:
        print('  ', c)
