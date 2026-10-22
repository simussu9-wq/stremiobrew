#!/usr/bin/env python3
"""Replace the build machine's home folder inside packaged files with a neutral path of the SAME length
(compilers keep build paths in binaries: ffmpeg's configure line, library source paths in assertions).
Same length = byte offsets don't move, so binaries are untouched apart from those strings.
usage: scrub-paths.py [--root DIR] FILE... ; exits non-zero if anything personal is still left.
--root: the source checkout, replaced first as a whole (its folder name is the builder's own choice)."""
import os, sys

def same_len(base, n):  # a neutral path of exactly n characters ('/.' pads a path without changing it)
    return (base + '/.' * 64)[:n]
args = sys.argv[1:]
root = None
if args[:1] == ['--root']:
    root = os.path.realpath(args[1]).rstrip('/'); args = args[2:]

home = os.path.expanduser('~').rstrip('/')
user = os.path.basename(home)
neutral = same_len('/home/builder', len(home))  # '/Users/name' -> '/home/builder' (padded or cut to fit)
if len(neutral) != len(home):
    sys.exit('cannot build a same-length replacement for ' + home)
bad = 0
for f in args:
    b = open(f, 'rb').read()
    n = 0
    if root and len(root) >= 18:
        n += b.count(root.encode()); b = b.replace(root.encode(), same_len('/build/stremiobrew', len(root)).encode())
    n += b.count(home.encode())
    b = b.replace(home.encode(), neutral.encode())
    if n:
        open(f, 'wb').write(b)
    left = [w for w in (home, '/Users/' + user, user + '@') if w.encode() in b]
    print('%-60s %3d path(s) replaced%s' % (f[-60:], n, ('  STILL CONTAINS ' + ', '.join(left)) if left else ''))
    bad += bool(left)
sys.exit(1 if bad else 0)
