#!/usr/bin/env python3
"""Burn SRT captions into a video with Pillow + ffmpeg overlay (this ffmpeg build has no subtitles/drawtext filter).

Usage:
  burn-captions.py --video in.mov --srt video/captions.srt --out video/raw/out/tender-full.mp4
  burn-captions.py --selftest
Requires Pillow and ffmpeg/ffprobe on PATH.
"""
import argparse, os, re, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
FONT_PX = 40
BAND_H = 160

def ts(s):
    h, m, rest = s.strip().split(':'); sec, ms = rest.split(',')
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000

def parse_srt(path):
    cues = []
    for block in re.split(r'\n\s*\n', open(path, encoding='utf-8').read().strip()):
        lines = block.strip().split('\n')
        a, b = lines[1].split('-->')
        cues.append((ts(a), ts(b), lines[2:]))
    return cues

def probe(path, entries):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', entries,
                          '-of', 'csv=p=0', path], capture_output=True, text=True, check=True).stdout.strip()
    return out.split(',')

def draw_cue(lines, width, path):
    font = ImageFont.truetype(FONT, FONT_PX)
    img = Image.new('RGBA', (width, BAND_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lh = FONT_PX + 8
    widths = [d.textlength(l, font=font) for l in lines]
    box_w, box_h = int(max(widths)) + 40, lh * len(lines) + 20
    x0, y1 = (width - box_w) // 2, BAND_H - 4
    d.rectangle([x0, y1 - box_h, x0 + box_w, y1], fill=(0, 0, 0, 153))
    for i, l in enumerate(lines):
        d.text(((width - widths[i]) / 2, y1 - box_h + 10 + i * lh), l, font=font, fill=(255, 255, 255, 255))
    img.save(path)

def burn(video, srt, out):
    cues = parse_srt(srt)
    width = int(probe(video, 'stream=width')[0])
    cdir = os.path.join(os.path.dirname(os.path.abspath(out)), 'cues'); os.makedirs(cdir, exist_ok=True)
    cmd = ['ffmpeg', '-y', '-i', video]
    for n, (_, _, lines) in enumerate(cues, 1):
        p = os.path.join(cdir, f'{n}.png'); draw_cue(lines, width, p); cmd += ['-i', p]
    chain, last = [], '0:v'
    for n, (a, b, _) in enumerate(cues, 1):
        o = f'v{n}'
        chain.append(f"[{last}][{n}:v]overlay=0:H-h-40:enable='between(t,{a:.3f},{b:.3f})'[{o}]"); last = o
    cmd += ['-filter_complex', ';'.join(chain), '-map', f'[{last}]', '-map', '0:a?',
            '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
            '-movflags', '+faststart', out]
    subprocess.run(cmd, check=True, capture_output=True)
    dur = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out],
                         capture_output=True, text=True, check=True).stdout.strip()
    print(dur)
    return float(dur)

def selftest():
    with tempfile.TemporaryDirectory() as t:
        v, s, o = os.path.join(t, 'in.mp4'), os.path.join(t, 'c.srt'), os.path.join(t, 'out', 'o.mp4')
        os.makedirs(os.path.dirname(o))
        subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=3:r=25', '-f', 'lavfi',
                        '-i', 'anullsrc=r=44100:cl=mono', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', v], check=True, capture_output=True)
        open(s, 'w').write('1\n00:00:00,000 --> 00:00:01,400\nFirst test cue\nsecond line\n\n2\n00:00:01,500 --> 00:00:03,000\nSecond test cue\n')
        dur = burn(v, s, o)
        assert abs(dur - 3.0) < 0.2, dur
        assert len(os.listdir(os.path.join(t, 'out', 'cues'))) == 2
    print('selftest ok')

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--video'); ap.add_argument('--srt'); ap.add_argument('--out'); ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest: selftest()
    elif a.video and a.srt and a.out: os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True); burn(a.video, a.srt, a.out)
    else: ap.error('need --selftest or --video/--srt/--out')
