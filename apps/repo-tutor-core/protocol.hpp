#pragma once

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
	// 处理一行输入，返回一行响应。通知（没有 id）返回空串。
	std::string handle_line(const std::string& line);

private:
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
	TutorSession session_;
	EvidenceBudget evidence_;
	RepositoryMap repository_;
	std::optional<QuestionContract> question_;
	int next_question_id_ = 1;
	std::string evidence_snapshot_id_;
};

// 协议里的 depth/coverage 字符串 <-> 枚举。
DepthProfile depth_from_string(const std::string& name);
std::string depth_to_string(DepthProfile depth);
CoverageProfile coverage_from_string(const std::string& name);
std::string coverage_to_string(CoverageProfile coverage);

} // namespace repo_tutor::protocol
