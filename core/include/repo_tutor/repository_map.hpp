#pragma once

#include <string>
#include <vector>

// RepositoryMap 是 Repository Engine 的结构信号产物：文件清单 + 按扩展名判断的语言。
// M1 版本只做本地目录遍历，不做符号、依赖图、call graph——那些后面再加。

namespace repo_tutor
{

struct RepositoryFile
{
	std::string relative_path; // 相对 repo root 的路径，用 '/' 分隔
	std::string language;      // 按扩展名判断，判断不出就是 "unknown"
};

struct RepositoryMap
{
	std::string root; // 规范化后的绝对路径
	std::vector<RepositoryFile> files;
};

// 扫描本地目录，产出 RepositoryMap。
// 会跳过 .git、build、node_modules、out 等生成/依赖目录，不跟随目录符号链接。
RepositoryMap scan_repository(const std::string& root);

// 按扩展名判断语言。判断不出返回 "unknown"。
std::string language_of(const std::string& relative_path);

// 这个目录名该不该在扫描时跳过。
bool is_skipped_directory(const std::string& directory_name);

} // namespace repo_tutor
