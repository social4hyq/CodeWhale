#!/bin/sh
# patch-ohos.sh — Patch CodeWhale dependencies for OpenHarmony (musl/ohos target)
set -e

echo "=== Patching rustyline (ioctl_read_bad → libc::ioctl) ==="

find "${HOME}/.cargo/registry/src" -path '*/rustyline-*/src/tty/unix.rs' -type f 2>/dev/null | while read -r f; do
    if grep -q 'nix::ioctl_read_bad!' "$f" 2>/dev/null; then
        echo "  Patching: $f"
        cat > /tmp/rustyline_patch.py << 'PYEOF'
import sys
f = sys.argv[1]
with open(f, 'r') as fh:
    content = fh.read()
old = 'nix::ioctl_read_bad!(win_size, libc::TIOCGWINSZ, libc::winsize);'
new = '''unsafe fn win_size(fd: libc::c_int, size: &mut libc::winsize) -> nix::Result<libc::c_int> {
    let res = libc::ioctl(fd, libc::TIOCGWINSZ as _, size);
    nix::errno::Errno::result(res)
}'''
content = content.replace(old, new)
with open(f, 'w') as fh:
    fh.write(content)
PYEOF
        python3 /tmp/rustyline_patch.py "$f"
    fi
done

echo "=== Patching aws-lc-sys (allow NO_ASM in release) ==="

find "${HOME}/.cargo/registry/src" -path '*/aws-lc-sys-*/builder/cc_builder.rs' -type f 2>/dev/null | while read -r f; do
    if grep -q 'AWS_LC_SYS_NO_ASM only allowed for debug builds' "$f" 2>/dev/null; then
        echo "  Patching cc_builder: $f"
        cat > /tmp/aws_lc_patch.py << 'PYEOF'
import sys
f = sys.argv[1]
with open(f, 'r') as fh:
    content = fh.read()

old = '''            _ => {
                assert!(
                    !is_no_asm(),
                    "AWS_LC_SYS_NO_ASM only allowed for debug builds!"
                );
                if !compiler_is_msvc {'''

new = '''            _ => {
                if is_no_asm() {
                    emit_warning("AWS_LC_SYS_NO_ASM found. Disabling assembly code usage.");
                    build_options.push(BuildOption::define("OPENSSL_NO_ASM", "1"));
                } else if !compiler_is_msvc {'''

content = content.replace(old, new)
with open(f, 'w') as fh:
    fh.write(content)
PYEOF
        python3 /tmp/aws_lc_patch.py "$f"
    fi
done

find "${HOME}/.cargo/registry/src" -path '*/aws-lc-sys-*/builder/cmake_builder.rs' -type f 2>/dev/null | while read -r f; do
    if grep -q 'AWS_LC_SYS_NO_ASM only allowed for debug builds' "$f" 2>/dev/null; then
        echo "  Patching cmake_builder: $f"
        cat > /tmp/aws_lc_cmake_patch.py << 'PYEOF'
import sys
f = sys.argv[1]
with open(f, 'r') as fh:
    content = fh.read()

old = '''        if is_no_asm() {
            let opt_level = cargo_env("OPT_LEVEL");
            if opt_level == "0" {
                cmake_cfg.define("OPENSSL_NO_ASM", "1");
            } else {
                panic!("AWS_LC_SYS_NO_ASM only allowed for debug builds!")
            }
        }'''

new = '''        if is_no_asm() {
            cmake_cfg.define("OPENSSL_NO_ASM", "1");
        }'''

content = content.replace(old, new)
with open(f, 'w') as fh:
    fh.write(content)
PYEOF
        python3 /tmp/aws_lc_cmake_patch.py "$f"
    fi
done

echo "=== All patches applied ==="
