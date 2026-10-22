#!/usr/bin/env python3
"""Strip a static 32-bit little-endian ELF the simple way: everything past the last loadable
segment is only symbols/notes (.symtab, .strtab, .comment...), never mapped at run time, so cut
it and drop the section-header table (the kernel loads programs from program headers only).
(An earlier P2P binary went from 21.7 MB to 14.7 MB this way, with no change to the code that runs.)"""
import struct, sys
src, dst = sys.argv[1], sys.argv[2]
b = bytearray(open(src, 'rb').read())
assert b[:4] == b'\x7fELF' and b[4] == 1 and b[5] == 1, 'expects ELF32 little-endian'
phoff, = struct.unpack_from('<I', b, 0x1C)
phentsize, phnum = struct.unpack_from('<HH', b, 0x2A)
end = 0
for i in range(phnum):
    p = struct.unpack_from('<IIIIIIII', b, phoff + i * phentsize)
    if p[0] != 0:  # every non-null program header must survive
        end = max(end, p[1] + p[4])
out = b[:end]
struct.pack_into('<I', out, 0x20, 0)           # e_shoff
struct.pack_into('<HHH', out, 0x2E, 0, 0, 0)   # e_shentsize, e_shnum, e_shstrndx
open(dst, 'wb').write(out)
print('%s: %d -> %d bytes' % (dst, len(b), len(out)))
