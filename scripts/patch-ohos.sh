#!/bin/sh
# patch-ohos.sh — Patch CodeWhale dependencies for OpenHarmony (musl/ohos target)
#
# 修复两个兼容性问题:
#   1. rustyline 的 nix::ioctl_read_bad! 宏在 ohos target 上类型不匹配 (u64 vs i32)
#   2. aws-lc-sys 的 AWS_LC_SYS_NO_ASM 在 release 模式下被禁止

set -e

echo "=== Patching rustyline (ioctl_read_bad → libc::ioctl) ==="

# 查找所有版本的 rustyline unix tty 源码并修补
find "${HOME}/.cargo/registry/src" -path '*/rustyline-*/src/tty/unix.rs' -type f | while read -r f; do
    if grep -q 'nix::ioctl_read_bad!' "$f"; then
        echo "  Patching: $f"
        # 用 unsafe fn 直接调用 libc::ioctl 替换 nix::ioctl_read_bad! 宏
        sed -i 's|^nix::ioctl_read_bad!(win_size, libc::TIOCGWINSZ, libc::winsize);|unsafe fn win_size(fd: libc::c_int, size: \&mut libc::winsize) -> nix::Result<libc::c_int> {\n    let res = libc::ioctl(fd, libc::TIOCGWINSZ as _, size);\n    nix::errno::Errno::result(res)\n}|' "$f"
    fi
done

echo "=== Patching aws-lc-sys (allow NO_ASM in release) ==="

# 查找 aws-lc-sys 的 cc_builder.rs 并修补
find "${HOME}/.cargo/registry/src" -path '*/aws-lc-sys-*/builder/cc_builder.rs' -type f | while read -r f; do
    if grep -q 'AWS_LC_SYS_NO_ASM only allowed for debug builds' "$f"; then
        echo "  Patching cc_builder: $f"
        # 替换 assert panic 为允许 NO_ASM
        sed -i '/_ => {/{
            N
            /assert!/,/)/{
                s|assert!(\n.*!is_no_asm(),\n.*"AWS_LC_SYS_NO_ASM only allowed for debug builds!"\n.*);|if is_no_asm() {\n                    emit_warning("AWS_LC_SYS_NO_ASM found. Disabling assembly code usage.");\n                    build_options.push(BuildOption::define("OPENSSL_NO_ASM", "1"));\n                } else if !compiler_is_msvc {|
            }
        }' "$f"
    fi
done

# 查找 cmake_builder.rs 并修补
find "${HOME}/.cargo/registry/src" -path '*/aws-lc-sys-*/builder/cmake_builder.rs' -type f | while read -r f; do
    if grep -q 'AWS_LC_SYS_NO_ASM only allowed for debug builds' "$f"; then
        echo "  Patching cmake_builder: $f"
        # 替换 panic 为直接设置 OPENSSL_NO_ASM
        sed -i 's|if is_no_asm() {|if is_no_asm() {\n            cmake_cfg.define("OPENSSL_NO_ASM", "1");\n        }\n        if false {|' "$f"
        # 清理多余的旧逻辑
        sed -i '/let opt_level = cargo_env("OPT_LEVEL");/d' "$f"
        sed -i '/if opt_level == "0" {/d' "$f"
        sed -i '/cmake_cfg.define("OPENSSL_NO_ASM", "1");/d' "$f" 2>/dev/null || true
        sed -i '/panic!("AWS_LC_SYS_NO_ASM only allowed for debug builds!")/d' "$f"
    fi
done

echo "=== All patches applied ==="
