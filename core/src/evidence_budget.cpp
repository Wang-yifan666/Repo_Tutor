#include "repo_tutor/evidence_budget.hpp"

#include <algorithm>
#include <utility>

namespace repo_tutor
{

namespace
{

// 只接受仓库内的相对路径：不能为空、不能是绝对路径、不能有 .. 段。
bool is_safe_relative_path(const std::string& path)
{
	if(path.empty())
	{
		return false;
	}

	// POSIX 绝对路径
	if(path.front() == '/' || path.front() == '\\')
	{
		return false;
	}

	// Windows 盘符，如 "C:foo" 或 "C:\foo"
	if(path.size() >= 2 && path[1] == ':')
	{
		return false;
	}

	// 逐段检查，拒绝 .. 和空段（"a//b" 这类）。
	std::size_t start = 0;
	while(start <= path.size())
	{
		const std::size_t end = path.find_first_of("/\\", start);
		const std::string segment =
		    path.substr(start, end == std::string::npos ? std::string::npos : end - start);
		if(segment.empty() || segment == "..")
		{
			return false;
		}
		if(end == std::string::npos)
		{
			break;
		}
		start = end + 1;
	}
	return true;
}

} // namespace

std::size_t EvidenceBudget::files_read() const
{
	std::vector<std::string> paths;
	paths.reserve(ledger.size());
	for(const auto& entry: ledger)
	{
		paths.push_back(entry.relative_path);
	}

	std::sort(paths.begin(), paths.end());
	paths.erase(std::unique(paths.begin(), paths.end()), paths.end());
	return paths.size();
}

bool EvidenceBudget::has_read(const std::string& relative_path) const
{
	return std::any_of(ledger.begin(), ledger.end(), [&relative_path](const EvidenceEntry& entry) {
		return entry.relative_path == relative_path;
	});
}

EvidenceRecordResult record_evidence(EvidenceBudget& budget, EvidenceEntry entry)
{
	if(!is_safe_relative_path(entry.relative_path))
	{
		return EvidenceRecordResult::blocked_escape;
	}

	budget.ledger.push_back(std::move(entry));
	return EvidenceRecordResult::allowed;
}

std::size_t soft_file_cap(DepthProfile depth)
{
	switch(depth)
	{
	case DepthProfile::d1_overview:
		return 3;
	case DepthProfile::d2_working:
		return 6;
	case DepthProfile::d3_implementation:
		return 12;
	case DepthProfile::d4_forensic:
		return 24;
	}

	// 不应该走到这里，但保留一个显式默认值。
	return 6;
}

} // namespace repo_tutor
