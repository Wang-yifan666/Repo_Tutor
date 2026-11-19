#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>

#include "repo_tutor/repository_map.hpp"

namespace
{

void check(bool condition, const char* message)
{
	if(!condition)
	{
		std::fprintf(stderr, "FAILED: %s\n", message);
		std::exit(1);
	}
}

void write_file(const std::filesystem::path& path)
{
	std::ofstream stream(path);
	check(static_cast<bool>(stream), "test fixture file should be writable");
	stream << "// fixture\n";
}

bool contains_file(const repo_tutor::RepositoryMap& map, const char* relative_path)
{
	for(const auto& file: map.files)
	{
		if(file.relative_path == relative_path)
		{
			return true;
		}
	}
	return false;
}

const repo_tutor::RepositoryFile* find_file(const repo_tutor::RepositoryMap& map,
                                            const char* relative_path)
{
	for(const auto& file: map.files)
	{
		if(file.relative_path == relative_path)
		{
			return &file;
		}
	}
	return nullptr;
}

} // namespace

int main()
{
	// 扩展名判断
	{
		check(repo_tutor::language_of("src/main.cpp") == "cpp", "cpp extension should map to cpp");
		check(repo_tutor::language_of("include/util.hpp") == "cpp-header",
		      "hpp extension should map to cpp-header");
		check(repo_tutor::language_of("README.md") == "markdown",
		      "md extension should map to markdown");
		check(repo_tutor::language_of("noext") == "unknown", "missing extension should be unknown");
		check(repo_tutor::language_of("dir.v2/file") == "unknown",
		      "dot before separator should be unknown");
	}

	// 跳过目录判断
	{
		check(repo_tutor::is_skipped_directory("build"), "build should be skipped");
		check(repo_tutor::is_skipped_directory(".git"), ".git should be skipped");
		check(repo_tutor::is_skipped_directory("node_modules"), "node_modules should be skipped");
		check(!repo_tutor::is_skipped_directory("src"), "src should not be skipped");
	}

	// 真实目录扫描
	{
		const auto suffix =
		    std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
		const auto root = std::filesystem::temp_directory_path() / ("repo_tutor_scan_" + suffix);

		std::filesystem::create_directories(root / "src");
		std::filesystem::create_directories(root / "build");
		std::filesystem::create_directories(root / "node_modules");
		std::filesystem::create_directories(root / ".git");

		write_file(root / "src" / "main.cpp");
		write_file(root / "src" / "util.hpp");
		write_file(root / "README.md");
		write_file(root / "build" / "ignored.cpp");
		write_file(root / "node_modules" / "dep.js");
		write_file(root / ".git" / "config");

		const repo_tutor::RepositoryMap map = repo_tutor::scan_repository(root.string());

		const repo_tutor::RepositoryFile* main_cpp = find_file(map, "src/main.cpp");
		check(main_cpp != nullptr, "scan should find src/main.cpp");
		check(main_cpp->language == "cpp", "src/main.cpp should be cpp");

		check(contains_file(map, "src/util.hpp"), "scan should find src/util.hpp");
		check(contains_file(map, "README.md"), "scan should find README.md");

		check(!contains_file(map, "build/ignored.cpp"), "build directory should be skipped");
		check(!contains_file(map, "node_modules/dep.js"), "node_modules should be skipped");
		check(!contains_file(map, ".git/config"), ".git should be skipped");

		std::filesystem::remove_all(root);
	}

	std::printf("all repository-map checks passed\n");
	return 0;
}
