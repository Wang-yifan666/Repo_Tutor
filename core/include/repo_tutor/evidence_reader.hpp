#pragma once

#include <cstddef>
#include <string>

// 证据读取：把仓库里的一段代码取出来，交给教学过程使用。
//
// 读文件这件事必须留在 Core：路径安全（不许跑出仓库）、行号裁剪、
// 字节上限都在这里定。宿主和协议层都不要自己读源码，否则 Evidence Budget
// 记的账和模型看到的代码就是两回事了。

namespace repo_tutor
{

// 一次证据读取的字节上限。太小讲不清一段机制，太大又会把工具结果撑爆
// （DSH 那边对过大的工具结果还有一层裁剪，没必要撞上去）。
constexpr std::size_t kMaxEvidenceBytes = 6000;

// 没给 lineEnd 时默认往下读多少行。
constexpr int kDefaultEvidenceLines = 120;

struct EvidenceSlice
{
	enum class Status
	{
		ok,
		blocked_no_root,  // 会话还不知道仓库根在哪
		blocked_escape,   // 路径想跑出仓库
		blocked_missing,  // 文件不存在
		blocked_not_file, // 存在，但不是普通文件
	};

	Status status = Status::blocked_no_root;

	std::string content;
	int first_line = 0;    // 真正取到的第一行（1 起）
	int last_line = 0;     // 真正取到的最后一行（闭区间）
	int total_lines = 0;   // 文件一共多少行
	bool truncated = false; // 是不是被字节上限截断
};

// 从 root 下读 relative_path 的 [line_start, line_end] 区间。
// line_start <= 0 视为从第一行开始；line_end <= 0 或超过文件末尾都按实际范围收。
EvidenceSlice read_evidence_slice(const std::string& root,
                                  const std::string& relative_path,
                                  int line_start,
                                  int line_end,
                                  std::size_t max_bytes = kMaxEvidenceBytes);

} // namespace repo_tutor
