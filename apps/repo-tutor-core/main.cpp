#include <cstdlib>
#include <iostream>
#include <string>

#include "protocol.hpp"

// M2：stdio 上逐行收 JSON-RPC 请求，逐行回响应。
// Framing 就是一行一个 JSON 对象；stderr 留给日志。
//
// 设了 REPO_TUTOR_TRACE=1 就把每条请求和响应摘到 stderr，
// 用来验证"模型真的走了这条协议路径"，平时不吵人。

namespace
{

bool trace_enabled()
{
	const char* value = std::getenv("REPO_TUTOR_TRACE");
	if(value == nullptr || value[0] == '\0')
	{
		return false;
	}
	return value[0] != '0';
}

// 响应可能很大（比如整个文件清单），截一段够定位就行。
// 4000 是照着"一份会话状态 / 一张学习地图"的大小定的，再长就没人看了。
constexpr std::size_t kTraceResponseChars = 4000;

} // namespace

int main()
{
	repo_tutor::protocol::Server server;

	if(trace_enabled())
	{
		server.set_trace([](const std::string& method, const std::string& response) {
			const std::string head = response.substr(0, kTraceResponseChars);
			std::cerr << "[core] " << (method.empty() ? "<unknown>" : method) << " -> " << head
			          << (response.size() > kTraceResponseChars ? " ..." : "") << '\n';
			std::cerr.flush();
		});
	}

	std::string line;
	while(std::getline(std::cin, line))
	{
		const std::string response = server.handle_line(line);
		if(!response.empty())
		{
			std::cout << response << '\n';
			std::cout.flush();
		}
	}

	return 0;
}
