#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

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

std::string read_file(const std::string& path)
{
	std::ifstream stream(path);
	check(static_cast<bool>(stream), "output file should be readable");

	std::string text;
	std::string line;
	while(std::getline(stream, line))
	{
		text += line;
		text.push_back('\n');
	}
	return text;
}

std::vector<std::string> split_lines(const std::string& text)
{
	std::vector<std::string> lines;
	std::string current;
	for(const char c: text)
	{
		if(c == '\n')
		{
			if(!current.empty())
			{
				lines.push_back(current);
			}
			current.clear();
			continue;
		}
		current.push_back(c);
	}
	if(!current.empty())
	{
		lines.push_back(current);
	}
	return lines;
}

bool contains(const std::string& haystack, const std::string& needle)
{
	return haystack.find(needle) != std::string::npos;
}

void write_file(const std::filesystem::path& path, const std::string& content)
{
	std::ofstream stream(path);
	check(static_cast<bool>(stream), "fixture file should be writable");
	stream << content;
}

} // namespace

int main(int argc, char** argv)
{
	check(argc >= 2, "usage: vertical_slice_test <repo-tutor-core-exe>");

	const std::string exe_path = argv[1];

	// 建一个小的临时仓库，让 repository.scan 有东西可扫。
	const auto suffix = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
	const auto root = std::filesystem::temp_directory_path() / ("repo_tutor_slice_" + suffix);
	std::filesystem::create_directories(root / "src");
	write_file(root / "src" / "main.cpp", "int main() { return 0; }\n");
	write_file(root / "README.md", "# demo\n");

	const std::string root_json = root.generic_string();

	// 一行一个请求，顺序就是完整的教学闭环。
	std::string requests;
	requests += "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"protocol.negotiate\",\"params\":{}}\n";
	requests +=
	    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session.start\",\"params\":{\"coverage\":"
	    "\"core_path\",\"defaultDepth\":\"d2_working\",\"root\":\"" +
	    root_json + "\"}}\n";
	requests +=
	    "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"repository.scan\",\"params\":{\"root\":\""
	    + root_json + "\"}}\n";
	requests +=
	    "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"learning_map.propose\",\"params\":{\"units\":["
	    "{\"id\":\"unit-1\",\"cognitiveGoal\":\"how main works\"},"
	    "{\"id\":\"unit-2\",\"cognitiveGoal\":\"what the utility does\"}]}}\n";
	requests +=
	    "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"unit.open\",\"params\":{\"unitId\":\"unit-1\"}}\n";
	requests += "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"evidence.read\",\"params\":{\"path\":"
	            "\"src/main.cpp\",\"lineStart\":1,\"lineEnd\":1,\"rationale\":\"entry\"}}\n";
	requests +=
	    "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"question.create\",\"params\":{\"unitId\":"
	    "\"unit-1\",\"type\":\"open_answer\",\"premise\":\"what does this program do when it "
	    "starts\",\"evaluationMode\":\"model_assisted\",\"evaluationCriteria\":\"mentions the "
	    "entry point\"}}\n";
	// 提问之后又读了一份新证据；评价时不许用它。
	requests += "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"evidence.read\",\"params\":{\"path\":"
	            "\"README.md\",\"lineStart\":1,\"lineEnd\":1,\"rationale\":\"post-question\"}}\n";
	requests +=
	    "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"answer.submit\",\"params\":{\"questionId\":"
	    "\"q-1\",\"answer\":\"it calls main\"}}\n";
	requests +=
	    "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"evaluation.record\",\"params\":{\"questionId\":"
	    "\"q-1\",\"correct\":true,\"feedback\":\"ok\"}}\n";
	requests += "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"unit.complete\",\"params\":{\"unitId\":"
	            "\"unit-1\"}}\n";
	requests +=
	    "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"unit.open\",\"params\":{\"unitId\":\"unit-2\"}}\n";
	requests += "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"session.get\",\"params\":{}}\n";

	const auto temp_dir = std::filesystem::temp_directory_path();
	const std::string input_path =
	    (temp_dir / ("repo_tutor_slice_in_" + suffix + ".jsonl")).string();
	const std::string output_path =
	    (temp_dir / ("repo_tutor_slice_out_" + suffix + ".jsonl")).string();

	{
		std::ofstream input(input_path);
		check(static_cast<bool>(input), "input file should be writable");
		input << requests;
	}

	std::string native_exe = exe_path;
#if defined(_WIN32)
	for(char& c: native_exe)
	{
		if(c == '/')
		{
			c = '\\';
		}
	}
#endif

#if defined(_WIN32)
	// std::system 会拼成 `cmd /c <command>`；外层再包一对引号绕开 cmd 的引号规则。
	const std::string command =
	    "\"\"" + native_exe + "\" < \"" + input_path + "\" > \"" + output_path + "\"\"";
#else
	const std::string command =
	    "\"" + native_exe + "\" < \"" + input_path + "\" > \"" + output_path + "\"";
#endif

	const int exit_code = std::system(command.c_str());
	check(exit_code == 0, "protocol process should exit with code 0");

	const std::vector<std::string> lines = split_lines(read_file(output_path));
	check(lines.size() == 13, "should get exactly one response per request");

	check(contains(lines[0], "\"protocolVersion\":\"0.1\""),
	      "negotiate should report protocol version");
	check(contains(lines[1], "\"sessionId\":\"session-1\""),
	      "session.start should create a session");
	check(contains(lines[2], "\"status\":\"scanned\""), "repository.scan should succeed");
	check(contains(lines[2], "\"fileCount\":2"), "scan should find the two fixture files");
	check(contains(lines[3], "\"status\":\"accepted\""), "learning_map.propose should be accepted");
	check(contains(lines[3], "\"unitCount\":2"), "accepted map should keep both units");
	check(contains(lines[4], "\"status\":\"opened\""), "unit.open should be allowed");
	check(contains(lines[5], "\"status\":\"recorded\""), "evidence.read should record");
	check(contains(lines[5], "\"filesRead\":1"), "one evidence file should be read");
	// 教学过程要拿到源码，不然单元里没法读代码。
	check(contains(lines[5], "int main() { return 0; }"),
	      "evidence.read should return the actual source line");
	check(contains(lines[6], "\"status\":\"created\""), "question.create should succeed");
	check(contains(lines[6], "\"evidenceCount\":1"),
	      "question should freeze the one evidence file read before it");
	check(contains(lines[7], "\"filesRead\":2"), "post-question evidence should still be recorded");

	// 关键：评价上下文只含冻结证据（1 个），不含提问后新读的 README（否则会是 2）。
	check(contains(lines[8], "\"status\":\"recorded\""), "answer.submit should record the answer");
	check(contains(lines[8], "\"evidenceCount\":1"),
	      "answer context must use only the frozen evidence snapshot");
	check(contains(lines[8], "\"path\":\"src/main.cpp\""),
	      "answer context should name the frozen evidence file");
	check(!contains(lines[8], "README.md"),
	      "answer context must not leak evidence read after the question");
	check(contains(lines[9], "\"status\":\"recorded\""), "evaluation.record should succeed");
	check(contains(lines[9], "\"correct\":true"), "evaluation should keep the verdict");
	check(contains(lines[10], "\"status\":\"completed\""), "unit.complete should mark completed");
	check(contains(lines[11], "\"status\":\"opened\""),
	      "switching after completion should be allowed");
	check(contains(lines[12], "\"currentUnitId\":\"unit-2\""), "session should now be on unit-2");

	std::filesystem::remove_all(root);
	std::remove(input_path.c_str());
	std::remove(output_path.c_str());

	std::printf("all vertical-slice checks passed\n");
	return 0;
}
