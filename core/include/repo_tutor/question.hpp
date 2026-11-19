#pragma once

#include <string>
#include <vector>

#include "repo_tutor/domain.hpp"
#include "repo_tutor/evidence_budget.hpp"

// 问题不是核心对象，只是验证 mental model 的可选机制。
// QuestionContract 在提问那一刻冻结判题需要的全部信息。

namespace repo_tutor
{

enum class QuestionType
{
	single_choice,
	multiple_choice,
	true_false,
	fill_in,
	open_answer,
	execution_trace,
	debugging,
	code_change_prediction,
	architecture_design,
};

// 题型和评价方式是两回事，互不决定。
enum class EvaluationMode
{
	deterministic,
	model_assisted,
};

// 提问时冻结的契约。repository 后续怎么变，都不能改这里的 premise。
struct QuestionContract
{
	std::string id;
	std::string unit_id;
	QuestionType type = QuestionType::open_answer;
	std::string premise;
	std::string evidence_snapshot_id;
	EvaluationMode evaluation_mode = EvaluationMode::model_assisted;
	std::string evaluation_criteria;
	int created_at_revision = 0;

	// 提问时冻结的证据。评价只能用这些，不许再探索新证据。
	std::vector<EvidenceEntry> evidence;
};

// 学习者提交的回答。
struct TutorAnswer
{
	std::string question_id;
	std::string text;
};

// 评价结果。voided 表示题目本身有缺陷，这次评分作废。
struct TutorEvaluation
{
	std::string question_id;
	bool correct = false;
	std::string feedback;
	bool voided = false;
};

const char* to_string(QuestionType type) noexcept;
const char* to_string(EvaluationMode mode) noexcept;

QuestionType question_type_from_string(const std::string& name);
EvaluationMode evaluation_mode_from_string(const std::string& name);

} // namespace repo_tutor
