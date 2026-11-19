#include "repo_tutor/repository_map.hpp"

#include <algorithm>
#include <filesystem>
#include <system_error>
#include <utility>

namespace repo_tutor
{

namespace
{

constexpr const char* kUnknownLanguage = "unknown";

// 目录名跳过表：版本控制、构建产物、依赖目录。
constexpr const char* kSkippedDirectoryNames[] = {
    ".git", ".hg", ".svn", "build", "out", "node_modules", "vcpkg_installed", ".cache",
};

// 扩展名 -> 语言。M1 只覆盖几个常见扩展名。
struct ExtensionMapping
{
	const char* extension;
	const char* language;
};

constexpr ExtensionMapping kExtensionMappings[] = {
    {".c", "c"},
    {".h", "c-header"},
    {".cpp", "cpp"},
    {".cc", "cpp"},
    {".cxx", "cpp"},
    {".hpp", "cpp-header"},
    {".hh", "cpp-header"},
    {".hxx", "cpp-header"},
    {".ts", "typescript"},
    {".tsx", "typescript"},
    {".js", "javascript"},
    {".jsx", "javascript"},
    {".py", "python"},
    {".rs", "rust"},
    {".go", "go"},
    {".java", "java"},
    {".cs", "csharp"},
    {".md", "markdown"},
    {".json", "json"},
    {".yml", "yaml"},
    {".yaml", "yaml"},
    {".toml", "toml"},
    {".cmake", "cmake"},
    {".sh", "shell"},
    {".ps1", "powershell"},
};

} // namespace

std::string language_of(const std::string& relative_path)
{
	const auto dot = relative_path.rfind('.');
	const auto slash = relative_path.find_last_of("/\\");

	// 没有扩展名，或者点出现在最后一个分隔符之前（如 "dir.v2/file"），都算 unknown。
	if(dot == std::string::npos || (slash != std::string::npos && dot < slash))
	{
		return kUnknownLanguage;
	}

	const std::string extension = relative_path.substr(dot);
	for(const auto& mapping: kExtensionMappings)
	{
		if(extension == mapping.extension)
		{
			return mapping.language;
		}
	}
	return kUnknownLanguage;
}

bool is_skipped_directory(const std::string& directory_name)
{
	for(const auto* skipped: kSkippedDirectoryNames)
	{
		if(directory_name == skipped)
		{
			return true;
		}
	}
	return false;
}

RepositoryMap scan_repository(const std::string& root)
{
	RepositoryMap result;

	std::error_code error;
	const std::filesystem::path root_path = std::filesystem::weakly_canonical(root, error);
	if(error)
	{
		return result;
	}
	result.root = root_path.string();

	const auto options = std::filesystem::directory_options::skip_permission_denied;
	for(std::filesystem::recursive_directory_iterator it(root_path, options, error), end; it != end;
	    it.increment(error))
	{
		if(error)
		{
			error.clear();
			continue;
		}

		const auto& entry = *it;
		if(entry.is_directory())
		{
			if(is_skipped_directory(entry.path().filename().string()))
			{
				it.disable_recursion_pending();
			}
			continue;
		}

		if(!entry.is_regular_file())
		{
			continue;
		}

		const auto relative = std::filesystem::relative(entry.path(), root_path, error);
		if(error)
		{
			error.clear();
			continue;
		}

		RepositoryFile file;
		file.relative_path = relative.generic_string();
		file.language = language_of(file.relative_path);
		result.files.push_back(std::move(file));
	}

	std::sort(result.files.begin(), result.files.end(),
	          [](const RepositoryFile& left, const RepositoryFile& right) {
		          return left.relative_path < right.relative_path;
	          });

	return result;
}

} // namespace repo_tutor
