#include "repo_tutor/evidence_reader.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <string>
#include <system_error>

#include "repo_tutor/evidence_budget.hpp"

namespace repo_tutor
{

namespace
{

// 候选路径规范化后必须还在 root 底下。符号链接指到仓库外面也要拦住。
bool stays_inside(const std::filesystem::path& root, const std::filesystem::path& candidate)
{
	std::error_code error;
	const std::filesystem::path relative = std::filesystem::relative(candidate, root, error);
	if(error)
	{
		return false;
	}

	const std::string text = relative.generic_string();
	return !text.empty() && text != ".." && text.rfind("../", 0) != 0;
}

} // namespace

EvidenceSlice read_evidence_slice(const std::string& root,
                                  const std::string& relative_path,
                                  int line_start,
                                  int line_end,
                                  std::size_t max_bytes)
{
	EvidenceSlice result;

	if(root.empty())
	{
		result.status = EvidenceSlice::Status::blocked_no_root;
		return result;
	}
	if(!is_safe_relative_path(relative_path))
	{
		result.status = EvidenceSlice::Status::blocked_escape;
		return result;
	}

	std::error_code error;
	const std::filesystem::path root_path = std::filesystem::weakly_canonical(root, error);
	if(error || root_path.empty())
	{
		result.status = EvidenceSlice::Status::blocked_no_root;
		return result;
	}

	const std::filesystem::path candidate =
	    std::filesystem::weakly_canonical(root_path / relative_path, error);
	if(error || !stays_inside(root_path, candidate))
	{
		result.status = EvidenceSlice::Status::blocked_escape;
		return result;
	}

	if(!std::filesystem::exists(candidate, error) || error)
	{
		result.status = EvidenceSlice::Status::blocked_missing;
		return result;
	}
	if(!std::filesystem::is_regular_file(candidate, error) || error)
	{
		result.status = EvidenceSlice::Status::blocked_not_file;
		return result;
	}

	std::ifstream stream(candidate, std::ios::binary);
	if(!stream)
	{
		result.status = EvidenceSlice::Status::blocked_missing;
		return result;
	}

	// 行号统一成 1 起、闭区间；没给上界就按默认行数往下读。
	const int first_wanted = line_start > 0 ? line_start : 1;
	const int last_wanted = line_end > 0 ? std::max(line_end, first_wanted)
	                                     : first_wanted + kDefaultEvidenceLines - 1;

	std::string line;
	int line_number = 0;
	bool capped = false;
	while(std::getline(stream, line))
	{
		++line_number;

		// Windows 换行会留个 '\r'，带进模型上下文没好处。
		if(!line.empty() && line.back() == '\r')
		{
			line.pop_back();
		}

		if(line_number < first_wanted || line_number > last_wanted)
		{
			continue;
		}

		// 撞了字节上限就不再往里塞，但行号还得继续数——
		// totalLines 要准，模型靠它决定下一段读哪儿。
		if(capped)
		{
			continue;
		}

		const std::size_t needed = line.size() + 1;
		if(result.content.size() + needed > max_bytes)
		{
			result.truncated = true;
			capped = true;
			continue;
		}

		if(result.content.empty())
		{
			result.first_line = line_number;
		}
		result.content += line;
		result.content.push_back('\n');
		result.last_line = line_number;
	}

	result.total_lines = line_number;
	result.status = EvidenceSlice::Status::ok;
	return result;
}

} // namespace repo_tutor
