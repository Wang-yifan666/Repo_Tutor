// 转发到包内的 preset 安装脚本。
//
// 真正的实现在 hosts/dsh/scripts/install-preset.mjs —— npm 包里发的就是这一份，
// 所以从 checkout 跑和从 tarball 装完再跑，走的是同一条路径。
//
// 用法：node scripts/install-preset.mjs [--id repo-tutor] [--core <路径>]

await import('../hosts/dsh/scripts/install-preset.mjs')
