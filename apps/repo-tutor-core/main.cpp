#include <iostream>
#include <string>

#include "protocol.hpp"

// M2：stdio 上逐行收 JSON-RPC 请求，逐行回响应。
// Framing 就是一行一个 JSON 对象；stderr 留给日志。

int main()
{
	repo_tutor::protocol::Server server;

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
