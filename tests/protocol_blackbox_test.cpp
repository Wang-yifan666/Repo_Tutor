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

} // namespace

int main(int argc, char** argv)
{
	check(argc >= 2, "usage: protocol_blackbox_test <repo-tutor-core-exe>");

	const std::string exe_path = argv[1];

	// 一行一个 JSON-RPC 请求。顺序就是协议该有的顺序。
	const std::string requests =
	    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"protocol.negotiate\",\"params\":{}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session.start\",\"params\":{\"coverage\":\"core_path\","
	    "\"units\":[{\"id\":\"unit-a\",\"cognitiveGoal\":\"how the parser works\"},"
	    "{\"id\":\"unit-b\",\"cognitiveGoal\":\"how the lexer works\"}]}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"unit.open\",\"params\":{\"unitId\":\"unit-a\"}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"unit.open\",\"params\":{\"unitId\":\"unit-b\"}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"unit.complete\",\"params\":{\"unitId\":\"unit-a\"}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"unit.open\",\"params\":{\"unitId\":\"unit-b\"}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"depth.push\",\"params\":{\"depth\":\"d3_implementation\"}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"depth.pop\",\"params\":{}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"evidence.read\",\"params\":{\"path\":\"../etc/passwd\","
	    "\"rationale\":\"escape\"}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"evidence.read\",\"params\":{\"path\":\"src/main.cpp\","
	    "\"lineStart\":1,\"lineEnd\":10,\"rationale\":\"entry\"}}\n"
	    "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"no.such.method\",\"params\":{}}\n";

	const auto suffix = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
	const auto temp_dir = std::filesystem::temp_directory_path();
	const std::string input_path =
	    (temp_dir / ("repo_tutor_protocol_in_" + suffix + ".jsonl")).string();
	const std::string output_path =
	    (temp_dir / ("repo_tutor_protocol_out_" + suffix + ".jsonl")).string();

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
	// std::system 会拼成 `cmd /c <command>`；command 以引号开头时，cmd 会吞掉
	// 首尾引号，所以外面再包一对引号。
	const std::string command =
	    "\"\"" + native_exe + "\" < \"" + input_path + "\" > \"" + output_path + "\"\"";
#else
	const std::string command =
	    "\"" + native_exe + "\" < \"" + input_path + "\" > \"" + output_path + "\"";
#endif
	const int exit_code = std::system(command.c_str());
	check(exit_code == 0, "protocol process should exit with code 0");

	const std::vector<std::string> lines = split_lines(read_file(output_path));
	check(lines.size() == 11, "should get exactly one response per request");

	check(contains(lines[0], "\"protocolVersion\":\"0.1\""),
	      "negotiate should report protocol version");
	check(contains(lines[1], "\"sessionId\":\"session-1\""),
	      "session.start should create a session");
	check(contains(lines[2], "\"status\":\"opened\""), "first unit.open should be allowed");
	check(contains(lines[3], "\"reason\":\"TOPIC_LOCKED\""),
	      "switching while unfinished should be locked");
	check(contains(lines[4], "\"status\":\"completed\""), "unit.complete should mark completed");
	check(contains(lines[5], "\"status\":\"opened\""),
	      "switching after completion should be allowed");
	check(contains(lines[6], "\"currentDepth\":\"d3_implementation\""),
	      "depth.push should raise depth");
	check(contains(lines[7], "\"status\":\"popped\""), "depth.pop should return to mainline");
	check(contains(lines[8], "\"reason\":\"ESCAPE\""), "escaping evidence path should be blocked");
	check(contains(lines[9], "\"status\":\"recorded\""), "safe evidence should be recorded");
	check(contains(lines[9], "\"filesRead\":1"), "recording one file should report one file read");
	check(contains(lines[10], "\"code\":-32601"), "unknown method should be method-not-found");

	std::remove(input_path.c_str());
	std::remove(output_path.c_str());

	std::printf("all protocol blackbox checks passed\n");
	return 0;
}
