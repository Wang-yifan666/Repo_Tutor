# Third-party notices

`repo-tutor-dsh` itself is MIT (see `LICENSE`). This file records what else ends up inside
the published packages, because a static binary carries code that is not ours.

The short version: **no third-party npm dependency, no third-party C++ library.**
The only foreign code is the C++ runtime that gets linked into `repo-tutor-core`.

## JavaScript side: nothing to declare

`src/`, `scripts/` and `preset/` import only `node:*` built-ins and their own relative files.
`package.json` has no `dependencies` — `optionalDependencies` points at our own platform
packages, nothing else. The plugin consumes DSH through the Cordis `ctx` it is handed; DSH
is a peer, installed by the user, not vendored here.

## C++ side: the standard library and the platform CRT

`repo-tutor-core` is built from this repository alone (`core/`, `apps/repo-tutor-core/`)
and links no third-party C++ library. It does link a C++ runtime, statically on every
published platform, so the binary runs without a toolchain installed:

| Component | Platform | How it is linked | Licence | Why we can stay MIT |
|---|---|---|---|---|
| libstdc++ (GCC 11.2.0/MinGW-w64 on Windows, GCC on Linux) | both | static | GPL-3.0-or-later **with the GCC Runtime Library Exception** | The RLE permits distributing the compiled binary under any licence, provided the runtime is not modified |
| libgcc, libgcc_eh | both | static | same as libstdc++ | same |
| libwinpthread | win32 | static | mingw-w64 runtime, permissive (ZPL-2.1 / public-domain parts) | permissive, no reciprocal obligation |
| mingw-w64 C runtime (CRT startup, `msvcrt.dll` import) | win32 | static + Windows import | mingw-w64 runtime permissive; `msvcrt.dll` ships with Windows | we import `msvcrt.dll`/`KERNEL32.dll`, never redistribute them |
| glibc (`libc.so.6`, `libm.so.6`, `ld-linux`) | linux | dynamic, unmodified | LGPL-2.1-or-later | dynamically linked, source not modified, nothing statically absorbed |
| Linux kernel vDSO | linux | dynamic | kernel licence, not redistributed | resolved at runtime from the kernel |

We do not modify the runtime sources, and no GPL source is redistributed: everything above is
linked from the tools' own install, not vendored into this repository.

Compiler and linker used for the published binaries:

- **win32-x64** — clang 21.1.5 (`--target=x86_64-w64-windows-gnu`), MinGW-w64 runtime, `-static`
- **linux-x64** — GCC (Ubuntu, glibc 2.39), `-static-libgcc -static-libstdc++`

`ldd` / `objdump -p` output for each published binary is asserted by
`scripts/make-platform-packages.mjs`; anything outside the platform's own system libraries
fails the build rather than shipping a binary that needs a DLL the user does not have.

## What is *not* declared here

- **DSH** and its packages are installed by the user alongside this one. They are not
  bundled, so their licences are the user's own copy to comply with.
- **The repositories you teach with** stay untouched: the Core reads files, it never copies
  them into a published artefact.
