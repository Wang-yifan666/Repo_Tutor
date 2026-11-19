#pragma once

#include <functional>
#include <optional>
#include <string>

#include "json.hpp"
#include "repo_tutor/domain.hpp"
#include "repo_tutor/evidence_budget.hpp"
#include "repo_tutor/question.hpp"
#include "repo_tutor/repository_map.hpp"

namespace repo_tutor::protocol
{

// 宿主中立的协议 server。逐行收 JSON-RPC 2.0 请求，逐行回响应。
// 这里只把协议映射到 Core，不引入任何宿主概念。
class Server
{
public:
	// 每处理完一个请求回什么。method 在解析失败时是空串。
	// 轨迹只给调试和验证用，Server 自己不写任何日志流。
	using TraceHandler = std::function<void(const std::string& method, const std::string& response)>;

	// 处理一行输入，返回一行响应。通知（没有 id）返回空串。
	std::string handle_line(const std::string& line);

	void set_trace(TraceHandler trace);

private:
	std::string handle_line_inner(const std::string& line, std::string& method_out);

	// 方法不存在时返回 nullopt。
	std::optional<json::Value> dispatch(const std::string& method, const json::Value& params);

	json::Value handle_negotiate(const json::Value& params);
	json::Value handle_session_start(const json::Value& params);
	json::Value handle_session_get(const json::Value& params);
	json::Value handle_repository_scan(const json::Value& params);
	json::Value handle_learning_map_propose(const json::Value& params);
	json::Value handle_unit_open(const json::Value& params);
	json::Value handle_unit_complete(const json::Value& params);
	json::Value handle_depth_push(const json::Value& params);
	json::Value handle_depth_pop(const json::Value& params);
	json::Value handle_evidence_read(const json::Value& params);
	json::Value handle_question_create(const json::Value& params);
	json::Value handle_answer_submit(const json::Value& params);
	json::Value handle_evaluation_record(const json::Value& params);

	LearningUnit* find_unit(const std::string& unit_id);

	bool session_started_ = false;

	// 仓库根。session.start 可以给一个，repository.scan 也会把它定下来。
	// evidence.read 只在这个根下面读文件。
	std::string root_;

	TutorSession session_;
	EvidenceBudget evidence_;
	RepositoryMap repository_;
	std::optional<QuestionContract> question_;
	int next_question_id_ = 1;

	TraceHandler trace_;
};

// 协议里的 depth/coverage 字符串 <-> 枚举。
DepthProfile depth_from_string(const std::string& name);
std::string depth_to_string(DepthProfile depth);
CoverageProfile coverage_from_string(const std::string& name);
std::string coverage_to_string(CoverageProfile coverage);

} // namespace repo_tutor::protocol
