#!/usr/bin/env python3
"""
ロゴの元画像 (白地・紺と緑) から、サイトで使う画像を一式作り直す。

  使い方:
    1. 新しいロゴを images/brand/logo-original.webp (または .png) として置く
    2. python3 -m venv .venv && .venv/bin/pip install pillow numpy
    3. .venv/bin/python scripts/make-logo-assets.py [元画像のパス]

  作るもの (images/brand/):
    logo.png / logo-white.png                   … 全体 (白地用 / 黒地用。黒地用は紺を白にした版)
    logo-mark.png / logo-mark-white.png         … 車のマークだけ (スマホのヘッダー)
    logo-horizontal.png / -white.png            … マーク + カタカナの横長版 (ヘッダー)
    favicon-32.png / apple-touch-icon.png / icon-512.png / og-image.png

  パーツ (上から: 車のマーク / カタカナ / 英字) の位置は、インクのある横帯を自動で検出する。
  色は元画像から多い順に2色 (紺・緑) を拾う。
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'images', 'brand') + os.sep
SRC = sys.argv[1] if len(sys.argv) > 1 else next(
    p for p in (OUT + 'logo-original.webp', OUT + 'logo-original.png') if os.path.exists(p))

a = np.asarray(Image.open(SRC).convert('RGB')).astype(float)
H, W, _ = a.shape
bg = np.median(np.concatenate([a[:20].reshape(-1, 3), a[-20:].reshape(-1, 3)]), axis=0)
ink = np.abs(a - bg).sum(2) > 60

# ---- 色: 紺 (青みが強い) と 緑 ----
def mode_color(px):
    q = (px // 4 * 4).astype(int)
    u, c = np.unique(q, axis=0, return_counts=True)
    return u[c.argmax()].astype(float)
NAVY = mode_color(a[ink & (a[:, :, 2] > a[:, :, 1] + 20)])
GREEN = mode_color(a[ink & (a[:, :, 1] > a[:, :, 0] + 60) & (a[:, :, 1] > a[:, :, 2] + 20)])
WHITE = np.array([255, 255, 255], float)
print('紺', NAVY.astype(int), '緑', GREEN.astype(int))

# ---- 背景と2色への分解 (輪郭のなめらかさを保って透過にする) ----
def unmix(color):
    v = color - bg
    return np.clip(((a - bg) @ v) / (v @ v), 0, 1)
tn, tg = unmix(NAVY), unmix(GREEN)
dn = np.linalg.norm(a - (bg + tn[..., None] * (NAVY - bg)), axis=2)
dg = np.linalg.norm(a - (bg + tg[..., None] * (GREEN - bg)), axis=2)
is_green = dg < dn
alpha = np.where(is_green, tg, tn)
alpha[alpha < 0.04] = 0
alpha = np.clip((alpha - 0.04) / 0.92, 0, 1)

# ---- パーツの位置 (インクのある横帯) ----
rows = ink.sum(1) > 0
bands, start = [], None
for y, v in enumerate(rows):
    if v and start is None:
        start = y
    if not v and start is not None:
        if y - start > 3:
            bands.append((start, y))
        start = None
if start is not None:
    bands.append((start, H))
if len(bands) < 2:
    sys.exit('パーツ (マークと文字) を見つけられませんでした: %r' % bands)

def box_of(y0, y1, m=4):
    cols = np.where(ink[y0:y1].any(0))[0]
    return (max(0, cols.min() - m), max(0, y0 - m), min(W, cols.max() + 1 + m), min(H, y1 + m))
MARK = box_of(*bands[0])
WORD = box_of(*bands[1])
FULL = box_of(bands[0][0], bands[-1][1])
print('帯', bands)

def render(navy_to, box):
    x0, y0, x1, y1 = box
    rgb = np.where(is_green[..., None], GREEN, navy_to)[y0:y1, x0:x1]
    al = (alpha[y0:y1, x0:x1] * 255).round().astype(np.uint8)
    return Image.fromarray(np.dstack([rgb.astype(np.uint8), al]), 'RGBA')

def pad(img, px):
    c = Image.new('RGBA', (img.width + 2 * px, img.height + 2 * px), (0, 0, 0, 0))
    c.paste(img, (px, px), img)
    return c

def save(img, name, maxw=None):
    if maxw and img.width > maxw:
        img = img.resize((maxw, round(img.height * maxw / img.width)), Image.LANCZOS)
    img.save(OUT + name, optimize=True)
    print('  %-28s %dx%d' % (name, img.width, img.height))

for suffix, navy_to in (('', NAVY), ('-white', WHITE)):
    save(pad(render(navy_to, FULL), 12), 'logo%s.png' % suffix, 1200)
    save(pad(render(navy_to, MARK), 8), 'logo-mark%s.png' % suffix, 800)
    m, w = render(navy_to, MARK), render(navy_to, WORD)
    h = 240
    m2 = m.resize((round(m.width * h / m.height), h), Image.LANCZOS)
    wh = round(h * 0.42)
    w2 = w.resize((round(w.width * wh / w.height), wh), Image.LANCZOS)
    gap = round(h * 0.22)
    hz = Image.new('RGBA', (m2.width + gap + w2.width, h), (0, 0, 0, 0))
    hz.paste(m2, (0, 0), m2)
    hz.paste(w2, (m2.width + gap, round((h - wh) / 2) + round(h * 0.06)), w2)
    save(pad(hz, 6), 'logo-horizontal%s.png' % suffix, 1400)

def icon(size, radius_ratio, scale):
    c = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=round(size * radius_ratio), fill=255)
    c.paste(Image.new('RGBA', (size, size), (255, 255, 255, 255)), (0, 0), mask)
    m = render(NAVY, MARK)
    tw = round(size * scale)
    m2 = m.resize((tw, round(m.height * tw / m.width)), Image.LANCZOS)
    c.paste(m2, ((size - m2.width) // 2, (size - m2.height) // 2), m2)
    return c
save(icon(32, 0.2, 0.92), 'favicon-32.png')
save(icon(180, 0.0, 0.84).convert('RGB'), 'apple-touch-icon.png')  # iOS は自分で角を丸める
save(icon(512, 0.22, 0.84), 'icon-512.png')

og = Image.new('RGB', (1200, 630), (255, 255, 255))
full = render(NAVY, FULL)
f2 = full.resize((860, round(full.height * 860 / full.width)), Image.LANCZOS)
og.paste(f2, ((1200 - f2.width) // 2, (630 - f2.height) // 2), f2)
og.save(OUT + 'og-image.png', optimize=True)
print('  og-image.png                 1200x630')
