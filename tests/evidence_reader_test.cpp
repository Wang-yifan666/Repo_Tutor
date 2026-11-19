#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>

#include "repo_tutor/evidence_reader.hpp"

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

void write_file(const std::filesystem::path& path, const std::string& content)
{
	std::ofstream stream(path);
	check(static_cast<bool>(stream), "fixture file should be writable");
	stream << content;
}

bool contains(const std::string& haystack, const std::string& needle)
{
	return haystack.find(needle) != std::string::npos;
}

} // namespace

int main()
{
	using repo_tutor::EvidenceSlice;
	using repo_tutor::read_evidence_slice;

	const auto suffix = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
	const auto root = std::filesystem::temp_directory_path() / ("repo_tutor_reader_" + suffix);
	std::filesystem::create_directories(root / "src");

	write_file(root / "src" / "sample.cpp", "int a = 1;\nint b = 2;\nint c = 3;\nint d = 4;\n");
	// 没有结尾换行，行数也得数对。
	write_file(root / "src" / "tail.txt", "alpha\nbeta");
	write_file(root / "src" / "long.txt",
	           "0123456789\n0123456789\n0123456789\n0123456789\n0123456789\n");

	const std::string root_text = root.generic_string();

	// 不给上下界：整个文件。
	{
		const EvidenceSlice slice = read_evidence_slice(root_text, "src/sample.cpp", 0, 0);
		check(slice.status == EvidenceSlice::Status::ok, "whole-file read should succeed");
		check(slice.total_lines == 4, "sample.cpp has 4 lines");
		check(slice.first_line == 1, "whole-file read starts at line 1");
		check(slice.last_line == 4, "whole-file read ends at line 4");
		check(contains(slice.content, "int a = 1;"), "content should include the first line");
		check(contains(slice.content, "int d = 4;"), "content should include the last line");
		check(!slice.truncated, "small file should not be truncated");
	}

	// 指定区间：只给 2..3，且是 1 起、闭区间。
	{
		const EvidenceSlice slice = read_evidence_slice(root_text, "src/sample.cpp", 2, 3);
		check(slice.status == EvidenceSlice::Status::ok, "range read should succeed");
		check(slice.first_line == 2 && slice.last_line == 3, "range should be reported back");
		check(!contains(slice.content, "int a = 1;"), "range read must not include line 1");
		check(contains(slice.content, "int b = 2;"), "range read should include line 2");
		check(contains(slice.content, "int c = 3;"), "range read should include line 3");
		check(!contains(slice.content, "int d = 4;"), "range read must not include line 4");
	}

	// 只给起点：往下读默认行数，不会因为没给 lineEnd 就返回空。
	{
		const EvidenceSlice slice = read_evidence_slice(root_text, "src/sample.cpp", 3, 0);
		check(slice.first_line == 3, "open-ended read should start where asked");
		check(slice.last_line == 4, "open-ended read should reach the end of a short file");
	}

	// 没有结尾换行也要数对行数。
	{
		const EvidenceSlice slice = read_evidence_slice(root_text, "src/tail.txt", 0, 0);
		check(slice.total_lines == 2, "file without trailing newline still has 2 lines");
		check(contains(slice.content, "beta"), "last line without newline should still be read");
	}

	// 字节上限：读得出来但会被截断，而且截断要标出来。
	{
		const EvidenceSlice slice = read_evidence_slice(root_text, "src/long.txt", 0, 0, 20);
		check(slice.truncated, "byte cap should mark the slice truncated");
		check(slice.last_line == 1, "byte cap should stop after the first line");
		check(slice.total_lines == 5, "total line count should still be exact");
	}

	// 逃逸：带 ..、绝对路径、空路径都不行。
	{
		check(read_evidence_slice(root_text, "../secret.txt", 0, 0).status ==
		          EvidenceSlice::Status::blocked_escape,
		      "parent-relative path should be blocked");
		check(read_evidence_slice(root_text, "src/../../secret.txt", 0, 0).status ==
		          EvidenceSlice::Status::blocked_escape,
		      "nested escape should be blocked");
		check(read_evidence_slice(root_text, "/etc/passwd", 0, 0).status ==
		          EvidenceSlice::Status::blocked_escape,
		      "absolute path should be blocked");
		check(read_evidence_slice(root_text, "", 0, 0).status ==
		          EvidenceSlice::Status::blocked_escape,
		      "empty path should be blocked");
	}

	// 找不到就是找不到，不要假装读到。
	{
		check(read_evidence_slice(root_text, "src/nope.cpp", 0, 0).status ==
		          EvidenceSlice::Status::blocked_missing,
		      "missing file should be reported");
		check(read_evidence_slice(root_text, "src", 0, 0).status ==
		          EvidenceSlice::Status::blocked_not_file,
		      "directory should be reported as not-a-file");
	}

	// 还没定仓库根时不许读。
	{
		check(read_evidence_slice("", "src/sample.cpp", 0, 0).status ==
		          EvidenceSlice::Status::blocked_no_root,
		      "empty root should be reported");
	}

	std::filesystem::remove_all(root);

	std::printf("all evidence-reader checks passed\n");
	return 0;
}
