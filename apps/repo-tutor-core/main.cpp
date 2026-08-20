#include <repo_tutor/version.hpp>

#include <cstdio>

// Batch 1 只干一件事：让可执行文件进程边界（apps/repo-tutor-core）
// 链接上宿主无关的 Core 库（core/），跑起来。现在还不做任何协议 I/O，
// 宿主无关的 Tutor 协议目前只是 docs/protocol.md 里的一份 DRAFT。

int main()
{
	std::printf("repo-tutor-core %s\n", repo_tutor::version_string());
	return 0;
}
