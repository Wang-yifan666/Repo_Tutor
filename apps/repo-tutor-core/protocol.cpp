#include "protocol.hpp"

#include <algorithm>
#include <exception>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "repo_tutor/depth.hpp"
#include "repo_tutor/evidence_reader.hpp"
#include "repo_tutor/topic_lock.hpp"

namespace repo_tutor::protocol
{

namespace
{

json::Value make_object()
{
	json::Value value;
	value.type = json::Value::Type::object;
	return value;
}

json::Value make_string(const std::string& text)
{
	json::Value value;
	value.type = json::Value::Type::string;
	value.string = text;
	return value;
}

json::Value make_number(double number)
{
	json::Value value;
	value.type = json::Value::Type::number;
	value.number = number;
	return value;
}

json::Value make_boolean(bool boolean)
{
	json::Value value;
	value.type = json::Value::Type::boolean;
	value.boolean = boolean;
	return value;
}

json::Value make_null()
{
	json::Value value;
	value.type = json::Value::Type::null;
	return value;
}

json::Value make_array()
{
	json::Value value;
	value.type = json::Value::Type::array;
	return value;
}

// 给 response 加上 "jsonrpc":"2.0" 和 "id"。
json::Value with_envelope(const json::Value& id)
{
	json::Value response = make_object();
	response.object.emplace_back("jsonrpc", make_string("2.0"));
	response.object.emplace_back("id", id);
	return response;
}

std::string unit_status_to_string(LearningUnitStatus status)
{
	switch(status)
	{
	case LearningUnitStatus::not_started:
		return "not_started";
	case LearningUnitStatus::in_progress:
		return "in_progress";
	case LearningUnitStatus::completed:
		return "completed";
	}
	return "not_started";
}

// blocked 结果：{"status":"blocked","reason":"..."}
json::Value blocked_result(const std::string& reason)
{
	json::Value result = make_object();
	result.object.emplace_back("status", make_string("blocked"));
	result.object.emplace_back("reason", make_string(reason));
	return result;
}

// evidence_reader 的失败原因 -> 协议里的 reason 字符串。
std::string evidence_status_reason(EvidenceSlice::Status status)
{
	switch(status)
	{
	case EvidenceSlice::Status::ok:
		return {};
	case EvidenceSlice::Status::blocked_no_root:
		return "NO_ROOT";
	case EvidenceSlice::Status::blocked_escape:
		return "ESCAPE";
	case EvidenceSlice::Status::blocked_missing:
		return "FILE_NOT_FOUND";
	case EvidenceSlice::Status::blocked_not_file:
		return "NOT_A_FILE";
	}
	return "FILE_NOT_FOUND";
}

} // namespace

DepthProfile depth_from_string(const std::string& name)
{
	if(name == "d1_overview")
	{
		return DepthProfile::d1_overview;
	}
	if(name == "d3_implementation")
	{
		return DepthProfile::d3_implementation;
	}
	if(name == "d4_forensic")
	{
		return DepthProfile::d4_forensic;
	}
	return DepthProfile::d2_working;
}

std::string depth_to_string(DepthProfile depth)
{
	switch(depth)
	{
	case DepthProfile::d1_overview:
		return "d1_overview";
	case DepthProfile::d2_working:
		return "d2_working";
	case DepthProfile::d3_implementation:
		return "d3_implementation";
	case DepthProfile::d4_forensic:
		return "d4_forensic";
	}
	return "d2_working";
}

CoverageProfile coverage_from_string(const std::string& name)
{
	if(name == "major_modules")
	{
		return CoverageProfile::major_modules;
	}
	if(name == "comprehensive")
	{
		return CoverageProfile::comprehensive;
	}
	return CoverageProfile::core_path;
}

std::string coverage_to_string(CoverageProfile coverage)
{
	switch(coverage)
	{
	case CoverageProfile::core_path:
		return "core_path";
	case CoverageProfile::major_modules:
		return "major_modules";
	case CoverageProfile::comprehensive:
		return "comprehensive";
	}
	return "core_path";
}

LearningUnit* Server::find_unit(const std::string& unit_id)
{
	for(auto& unit: session_.units)
	{
		if(unit.id == unit_id)
		{
			return &unit;
		}
	}
	return nullptr;
}

void Server::set_trace(TraceHandler trace)
{
	trace_ = std::move(trace);
}

std::string Server::handle_line(const std::string& line)
{
	std::string method;
	const std::string response = handle_line_inner(line, method);

	// 轨迹挂在最外层：不管这条请求从哪个分支返回，都能被看到。
	if(trace_ && !response.empty())
	{
		trace_(method, response);
	}
	return response;
}

std::string Server::handle_line_inner(const std::string& line, std::string& method_out)
{
	if(line.empty())
	{
		return {};
	}

	json::Value request;
	try
	{
		request = json::parse(line);
	}
	catch(const json::ParseError&)
	{
		json::Value error = make_object();
		error.object.emplace_back("code", make_number(-32700));
		error.object.emplace_back("message", make_string("parse error"));

		json::Value response = with_envelope(make_null());
		response.object.emplace_back("error", std::move(error));
		return json::serialize(response);
	}

	if(!request.is_object())
	{
		json::Value error = make_object();
		error.object.emplace_back("code", make_number(-32600));
		error.object.emplace_back("message", make_string("invalid request"));

		json::Value response = with_envelope(make_null());
		response.object.emplace_back("error", std::move(error));
		return json::serialize(response);
	}

	const json::Value* id = json::find_member(request, "id");
	const std::string method = json::string_member(request, "method");
	method_out = method;

	// 通知（没有 id）M2 不回应。
	if(id == nullptr)
	{
		return {};
	}

	if(method.empty())
	{
		json::Value error = make_object();
		error.object.emplace_back("code", make_number(-32600));
		error.object.emplace_back("message", make_string("invalid request: missing method"));

		json::Value response = with_envelope(*id);
		response.object.emplace_back("error", std::move(error));
		return json::serialize(response);
	}

	const json::Value* params = json::find_member(request, "params");
	const json::Value empty_params;

	const std::optional<json::Value> result =
	    dispatch(method, params != nullptr ? *params : empty_params);
	if(!result.has_value())
	{
		json::Value error = make_object();
		error.object.emplace_back("code", make_number(-32601));
		error.object.emplace_back("message", make_string("method not found: " + method));

		json::Value response = with_envelope(*id);
		response.object.emplace_back("error", std::move(error));
		return json::serialize(response);
	}

	json::Value response = with_envelope(*id);
	response.object.emplace_back("result", *result);
	return json::serialize(response);
}

std::optional<json::Value> Server::dispatch(const std::string& method, const json::Value& params)
{
	if(method == "protocol.negotiate")
	{
		return handle_negotiate(params);
	}
	if(method == "session.start")
	{
		return handle_session_start(params);
	}
	if(method == "session.get")
	{
		return handle_session_get(params);
	}
	if(method == "unit.open")
	{
		return handle_unit_open(params);
	}
	if(method == "unit.complete")
	{
		return handle_unit_complete(params);
	}
	if(method == "depth.push")
	{
		return handle_depth_push(params);
	}
	if(method == "depth.pop")
	{
		return handle_depth_pop(params);
	}
	if(method == "evidence.read")
	{
		return handle_evidence_read(params);
	}
	if(method == "repository.scan")
	{
		return handle_repository_scan(params);
	}
	if(method == "learning_map.propose")
	{
		return handle_learning_map_propose(params);
	}
	if(method == "question.create")
	{
		return handle_question_create(params);
	}
	if(method == "answer.submit")
	{
		return handle_answer_submit(params);
	}
	if(method == "evaluation.record")
	{
		return handle_evaluation_record(params);
	}
	return std::nullopt;
}

json::Value Server::handle_negotiate(const json::Value& /*params*/)
{
	json::Value result = make_object();
	result.object.emplace_back("protocolVersion", make_string("0.1"));

	json::Value capabilities = make_array();
	capabilities.array.push_back(make_string("topic_lock"));
	capabilities.array.push_back(make_string("depth_push_pop"));
	capabilities.array.push_back(make_string("evidence_budget"));
	result.object.emplace_back("capabilities", std::move(capabilities));

	return result;
}

json::Value Server::handle_session_start(const json::Value& params)
{
	session_ = TutorSession{};
	session_.id = "session-1";
	session_.coverage = coverage_from_string(json::string_member(params, "coverage"));
	session_.depth.default_depth = depth_from_string(json::string_member(params, "defaultDepth"));

	// 会话可以先认一个仓库根；不认也行，等 repository.scan 定。
	root_ = json::string_member(params, "root");

	if(const auto* units = json::array_member(params, "units"))
	{
		for(const auto& unit_value: *units)
		{
			LearningUnit unit;
			unit.id = json::string_member(unit_value, "id");
			unit.cognitive_goal = json::string_member(unit_value, "cognitiveGoal");
			if(!unit.id.empty())
			{
				session_.units.push_back(std::move(unit));
			}
		}
	}

	evidence_ = EvidenceBudget{};
	evidence_.cognitive_goal = "";
	evidence_.depth = session_.depth.current();
	question_.reset();
	session_started_ = true;

	json::Value result = make_object();
	result.object.emplace_back("sessionId", make_string(session_.id));
	result.object.emplace_back("coverage", make_string(coverage_to_string(session_.coverage)));
	result.object.emplace_back("currentDepth",
	                           make_string(depth_to_string(session_.depth.current())));
	result.object.emplace_back("root", make_string(root_));
	return result;
}

json::Value Server::handle_session_get(const json::Value& /*params*/)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}

	json::Value result = make_object();
	result.object.emplace_back("sessionId", make_string(session_.id));
	result.object.emplace_back("coverage", make_string(coverage_to_string(session_.coverage)));
	result.object.emplace_back("currentDepth",
	                           make_string(depth_to_string(session_.depth.current())));
	result.object.emplace_back("root", make_string(root_));

	json::Value units = make_array();
	for(const auto& unit: session_.units)
	{
		json::Value unit_value = make_object();
		unit_value.object.emplace_back("id", make_string(unit.id));
		unit_value.object.emplace_back("cognitiveGoal", make_string(unit.cognitive_goal));
		unit_value.object.emplace_back("status", make_string(unit_status_to_string(unit.status)));
		units.array.push_back(std::move(unit_value));
	}
	result.object.emplace_back("units", std::move(units));

	result.object.emplace_back(
	    "currentUnitId",
	    session_.current_unit_id.has_value() ? make_string(*session_.current_unit_id) : make_null());

	// 模型靠这两个数字判断"证据够不够、要不要再读"。
	result.object.emplace_back("filesRead",
	                           make_number(static_cast<double>(evidence_.files_read())));
	result.object.emplace_back("ledgerSize",
	                           make_number(static_cast<double>(evidence_.ledger.size())));
	result.object.emplace_back("openQuestionId",
	                           question_.has_value() ? make_string(question_->id) : make_null());

	return result;
}

json::Value Server::handle_unit_open(const json::Value& params)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}

	const std::string unit_id = json::string_member(params, "unitId");
	if(unit_id.empty())
	{
		return blocked_result("MISSING_UNIT_ID");
	}

	const TopicLockResult lock = check_open_unit(session_, unit_id);
	if(lock == TopicLockResult::blocked_unknown_unit)
	{
		return blocked_result("UNKNOWN_UNIT");
	}
	if(lock == TopicLockResult::blocked_current_unit_unfinished)
	{
		return blocked_result("TOPIC_LOCKED");
	}

	session_.current_unit_id = unit_id;
	if(LearningUnit* unit = find_unit(unit_id);
	   unit != nullptr && unit->status == LearningUnitStatus::not_started)
	{
		unit->status = LearningUnitStatus::in_progress;
	}

	// 换单元了，上一个单元的题作废：它冻结的证据是上一个单元的。
	question_.reset();

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("opened"));
	result.object.emplace_back("unitId", make_string(unit_id));
	return result;
}

json::Value Server::handle_unit_complete(const json::Value& params)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}

	const std::string unit_id = json::string_member(params, "unitId");
	LearningUnit* unit = find_unit(unit_id);
	if(unit == nullptr)
	{
		return blocked_result("UNKNOWN_UNIT");
	}

	// 只能结当前单元。别绕过 Topic Lock 去结一个没开过的单元。
	if(!session_.current_unit_id.has_value() || *session_.current_unit_id != unit_id)
	{
		return blocked_result("UNIT_NOT_OPEN");
	}

	unit->status = LearningUnitStatus::completed;
	question_.reset();

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("completed"));
	result.object.emplace_back("unitId", make_string(unit_id));
	result.object.emplace_back("revision", make_number(static_cast<double>(session_.revision)));
	return result;
}

json::Value Server::handle_depth_push(const json::Value& params)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}

	const DepthProfile deeper = depth_from_string(json::string_member(params, "depth"));

	if(push_depth(session_.depth, deeper) == DepthPushResult::blocked_not_deeper)
	{
		return blocked_result("NOT_DEEPER");
	}

	evidence_.depth = session_.depth.current();

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("pushed"));
	result.object.emplace_back("currentDepth",
	                           make_string(depth_to_string(session_.depth.current())));
	return result;
}

json::Value Server::handle_depth_pop(const json::Value& /*params*/)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}

	if(pop_depth(session_.depth) == DepthPopResult::blocked_empty)
	{
		return blocked_result("EMPTY");
	}

	evidence_.depth = session_.depth.current();

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("popped"));
	result.object.emplace_back("currentDepth",
	                           make_string(depth_to_string(session_.depth.current())));
	return result;
}

json::Value Server::handle_evidence_read(const json::Value& params)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}

	// 证据是为了当前认知目标读的。没有打开的单元，就没有认知目标。
	if(!session_.current_unit_id.has_value())
	{
		return blocked_result("UNIT_NOT_OPEN");
	}

	const std::string path = json::string_member(params, "path");
	if(path.empty())
	{
		return blocked_result("MISSING_PATH");
	}

	const int line_start = static_cast<int>(json::number_member(params, "lineStart"));
	const int line_end = static_cast<int>(json::number_member(params, "lineEnd"));
	const std::string rationale = json::string_member(params, "rationale");

	// 先真读到，再记账。读不出来的东西不算证据。
	const EvidenceSlice slice = read_evidence_slice(root_, path, line_start, line_end);
	if(slice.status != EvidenceSlice::Status::ok)
	{
		return blocked_result(evidence_status_reason(slice.status));
	}

	EvidenceEntry entry;
	entry.relative_path = path;
	entry.line_start = slice.first_line;
	entry.line_end = slice.last_line;
	entry.rationale = rationale;

	if(record_evidence(evidence_, std::move(entry)) == EvidenceRecordResult::blocked_escape)
	{
		return blocked_result("ESCAPE");
	}

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("recorded"));
	result.object.emplace_back("path", make_string(path));
	result.object.emplace_back("lineStart", make_number(static_cast<double>(slice.first_line)));
	result.object.emplace_back("lineEnd", make_number(static_cast<double>(slice.last_line)));
	result.object.emplace_back("totalLines", make_number(static_cast<double>(slice.total_lines)));
	result.object.emplace_back("truncated", make_boolean(slice.truncated));
	result.object.emplace_back("content", make_string(slice.content));
	result.object.emplace_back("filesRead",
	                           make_number(static_cast<double>(evidence_.files_read())));
	result.object.emplace_back("ledgerSize",
	                           make_number(static_cast<double>(evidence_.ledger.size())));
	result.object.emplace_back("softFileCap",
	                           make_number(static_cast<double>(soft_file_cap(evidence_.depth))));
	return result;
}

json::Value Server::handle_repository_scan(const json::Value& params)
{
	std::string root = json::string_member(params, "root");
	if(root.empty())
	{
		// 会话已经认过仓库根，就沿着它扫。
		root = root_;
	}
	if(root.empty())
	{
		return blocked_result("MISSING_ROOT");
	}

	repository_ = scan_repository(root);
	if(repository_.root.empty())
	{
		return blocked_result("ROOT_NOT_READABLE");
	}
	// 扫描拿到的是规范化后的绝对路径，evidence.read 之后都按它算。
	root_ = repository_.root;

	// 文件清单截断，避免响应过大；语言分布和顶层目录给全，模型靠它们切单元。
	constexpr std::size_t kMaxFilesInResponse = 80;
	constexpr std::size_t kMaxDirectories = 60;
	const std::size_t count = std::min(repository_.files.size(), kMaxFilesInResponse);

	json::Value files = make_array();
	std::map<std::string, std::size_t> language_counts;
	std::set<std::string> directories;

	for(std::size_t i = 0; i < repository_.files.size(); ++i)
	{
		const RepositoryFile& file = repository_.files[i];
		++language_counts[file.language];

		const std::size_t slash = file.relative_path.find('/');
		if(slash != std::string::npos)
		{
			directories.insert(file.relative_path.substr(0, slash));
		}

		if(i < count)
		{
			json::Value file_value = make_object();
			file_value.object.emplace_back("path", make_string(file.relative_path));
			file_value.object.emplace_back("language", make_string(file.language));
			files.array.push_back(std::move(file_value));
		}
	}

	// 按数量从多到少排，同数量的按名字排，保证同样的仓库每次输出一样。
	std::vector<std::pair<std::string, std::size_t>> languages(language_counts.begin(),
	                                                           language_counts.end());
	std::sort(languages.begin(), languages.end(),
	          [](const auto& left, const auto& right) {
		          if(left.second != right.second)
		          {
			          return left.second > right.second;
		          }
		          return left.first < right.first;
	          });

	json::Value language_values = make_array();
	for(const auto& [language, how_many]: languages)
	{
		json::Value entry = make_object();
		entry.object.emplace_back("language", make_string(language));
		entry.object.emplace_back("fileCount", make_number(static_cast<double>(how_many)));
		language_values.array.push_back(std::move(entry));
	}

	json::Value directory_values = make_array();
	for(const auto& directory: directories)
	{
		if(directory_values.array.size() >= kMaxDirectories)
		{
			break;
		}
		directory_values.array.push_back(make_string(directory));
	}

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("scanned"));
	result.object.emplace_back("root", make_string(repository_.root));
	result.object.emplace_back("fileCount",
	                           make_number(static_cast<double>(repository_.files.size())));
	result.object.emplace_back("files", std::move(files));
	result.object.emplace_back("languages", std::move(language_values));
	result.object.emplace_back("directories", std::move(directory_values));
	result.object.emplace_back("truncated",
	                           make_boolean(repository_.files.size() > kMaxFilesInResponse));
	return result;
}

json::Value Server::handle_learning_map_propose(const json::Value& params)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}

	const auto* units = json::array_member(params, "units");
	if(units == nullptr || units->empty())
	{
		return blocked_result("EMPTY_LEARNING_MAP");
	}

	std::vector<LearningUnit> proposed;
	std::vector<std::string> seen_ids;

	for(const auto& unit_value: *units)
	{
		LearningUnit unit;
		unit.id = json::string_member(unit_value, "id");
		unit.cognitive_goal = json::string_member(unit_value, "cognitiveGoal");

		if(unit.id.empty())
		{
			return blocked_result("UNIT_MISSING_ID");
		}
		if(unit.cognitive_goal.empty())
		{
			return blocked_result("UNIT_MISSING_COGNITIVE_GOAL");
		}
		if(std::find(seen_ids.begin(), seen_ids.end(), unit.id) != seen_ids.end())
		{
			return blocked_result("DUPLICATE_UNIT_ID");
		}

		seen_ids.push_back(unit.id);
		proposed.push_back(std::move(unit));
	}

	// 校验通过：Core 接管这份 LearningMap。
	session_.units = std::move(proposed);
	++session_.revision;

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("accepted"));
	result.object.emplace_back("unitCount", make_number(static_cast<double>(session_.units.size())));
	result.object.emplace_back("revision", make_number(static_cast<double>(session_.revision)));
	return result;
}

json::Value Server::handle_question_create(const json::Value& params)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}

	const std::string unit_id = json::string_member(params, "unitId");
	if(unit_id.empty())
	{
		return blocked_result("MISSING_UNIT_ID");
	}
	if(!session_.current_unit_id.has_value() || *session_.current_unit_id != unit_id)
	{
		return blocked_result("UNIT_NOT_OPEN");
	}

	const std::string premise = json::string_member(params, "premise");
	if(premise.empty())
	{
		return blocked_result("MISSING_PREMISE");
	}

	QuestionContract contract;
	contract.id = "q-" + std::to_string(next_question_id_++);
	contract.unit_id = unit_id;
	contract.type = question_type_from_string(json::string_member(params, "type"));
	contract.premise = premise;
	contract.evaluation_mode =
	    evaluation_mode_from_string(json::string_member(params, "evaluationMode"));
	contract.evaluation_criteria = json::string_member(params, "evaluationCriteria");
	contract.created_at_revision = session_.revision;

	// 冻结提问时的证据。之后的 evidence.read 不会改变这份快照。
	contract.evidence = evidence_.ledger;
	contract.evidence_snapshot_id = "snapshot-" + contract.id;

	question_ = std::move(contract);

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("created"));
	result.object.emplace_back("questionId", make_string(question_->id));
	result.object.emplace_back("unitId", make_string(question_->unit_id));
	result.object.emplace_back("type", make_string(to_string(question_->type)));
	result.object.emplace_back("evidenceSnapshotId", make_string(question_->evidence_snapshot_id));
	result.object.emplace_back("evidenceCount",
	                           make_number(static_cast<double>(question_->evidence.size())));
	result.object.emplace_back("revision",
	                           make_number(static_cast<double>(question_->created_at_revision)));
	return result;
}

json::Value Server::handle_answer_submit(const json::Value& params)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}
	if(!question_.has_value())
	{
		return blocked_result("NO_QUESTION");
	}

	const std::string question_id = json::string_member(params, "questionId");
	if(question_id != question_->id)
	{
		return blocked_result("UNKNOWN_QUESTION");
	}

	const std::string answer = json::string_member(params, "answer");
	if(answer.empty())
	{
		return blocked_result("EMPTY_ANSWER");
	}

	// 返回评估上下文。evidence 只用冻结的那份，不含提问后新读的证据。
	json::Value frozen = make_array();
	for(const auto& entry: question_->evidence)
	{
		json::Value entry_value = make_object();
		entry_value.object.emplace_back("path", make_string(entry.relative_path));
		entry_value.object.emplace_back("lineStart", make_number(static_cast<double>(entry.line_start)));
		entry_value.object.emplace_back("lineEnd", make_number(static_cast<double>(entry.line_end)));
		entry_value.object.emplace_back("rationale", make_string(entry.rationale));
		frozen.array.push_back(std::move(entry_value));
	}

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("recorded"));
	result.object.emplace_back("questionId", make_string(question_->id));
	result.object.emplace_back("unitId", make_string(question_->unit_id));
	result.object.emplace_back("type", make_string(to_string(question_->type)));
	result.object.emplace_back("premise", make_string(question_->premise));
	result.object.emplace_back("answer", make_string(answer));
	result.object.emplace_back("evaluationMode", make_string(to_string(question_->evaluation_mode)));
	result.object.emplace_back("evaluationCriteria", make_string(question_->evaluation_criteria));
	result.object.emplace_back("evidenceSnapshotId", make_string(question_->evidence_snapshot_id));
	result.object.emplace_back("evidence", std::move(frozen));
	result.object.emplace_back("evidenceCount",
	                           make_number(static_cast<double>(question_->evidence.size())));
	result.object.emplace_back("createdAtRevision",
	                           make_number(static_cast<double>(question_->created_at_revision)));
	return result;
}

json::Value Server::handle_evaluation_record(const json::Value& params)
{
	if(!session_started_)
	{
		return blocked_result("NO_SESSION");
	}
	if(!question_.has_value())
	{
		return blocked_result("NO_QUESTION");
	}

	const std::string question_id = json::string_member(params, "questionId");
	if(question_id != question_->id)
	{
		return blocked_result("UNKNOWN_QUESTION");
	}

	const json::Value* voided_member = json::find_member(params, "voided");
	const bool voided =
	    voided_member != nullptr && voided_member->is_bool() && voided_member->boolean;

	if(voided)
	{
		// 题目有缺陷：这次评分作废，不改状态。
		json::Value result = make_object();
		result.object.emplace_back("status", make_string("voided"));
		result.object.emplace_back("questionId", make_string(question_->id));
		return result;
	}

	const json::Value* correct_member = json::find_member(params, "correct");
	const bool correct =
	    correct_member != nullptr && correct_member->is_bool() && correct_member->boolean;
	const std::string feedback = json::string_member(params, "feedback");

	++session_.revision;

	json::Value result = make_object();
	result.object.emplace_back("status", make_string("recorded"));
	result.object.emplace_back("questionId", make_string(question_->id));
	result.object.emplace_back("correct", make_boolean(correct));
	result.object.emplace_back("feedback", make_string(feedback));
	result.object.emplace_back("revision", make_number(static_cast<double>(session_.revision)));
	return result;
}

} // namespace repo_tutor::protocol
