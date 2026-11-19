#pragma once

#include <cstddef>
#include <string>
#include <vector>

#include "repo_tutor/domain.hpp"

// Evidence Budget 不是"还剩多少额度"的计数器。它记录的是：
// 为了当前认知目标，在某个 Depth 下读过哪些证据、为什么读。
// 文件数上限只是软护栏，不是教学规则。

namespace repo_tutor
{

// 一条已读证据。rationale 记录"为什么读这段"，对应架构里的 expansion rationale。
struct EvidenceEntry
{
	std::string relative_path;
	int line_start = 0;
	int line_end = 0;
	std::string rationale;
};

struct EvidenceBudget
{
	std::string cognitive_goal;
	DepthProfile depth = DepthProfile::d2_working;
	std::vector<EvidenceEntry> ledger;

	// 读过的不同文件数。
	std::size_t files_read() const;

	// 这个文件是否读过。
	bool has_read(const std::string& relative_path) const;
};

enum class EvidenceRecordResult
{
	allowed,
	blocked_escape, // 空路径、绝对路径，或带 .. 的逃逸路径
};

// 这条相对路径能不能进仓库读。规则只在这里写一遍：
// 不能为空、不能是绝对路径（含 Windows 盘符）、不能有 .. 段、不能有空段。
// evidence_reader 也用这一条，免得两处规则慢慢走偏。
bool is_safe_relative_path(const std::string& path);

// 记录一次证据读取。只接受仓库内的相对路径。
EvidenceRecordResult record_evidence(EvidenceBudget& budget, EvidenceEntry entry);

// 软护栏：这个 Depth 下大致允许读多少个不同文件。
// 它是 resource guardrail，不是教学规则，不参与"该不该读"的判断。
std::size_t soft_file_cap(DepthProfile depth);

} // namespace repo_tutor
