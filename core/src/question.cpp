#include "repo_tutor/question.hpp"

namespace repo_tutor
{

const char* to_string(QuestionType type) noexcept
{
	switch(type)
	{
	case QuestionType::single_choice:
		return "single_choice";
	case QuestionType::multiple_choice:
		return "multiple_choice";
	case QuestionType::true_false:
		return "true_false";
	case QuestionType::fill_in:
		return "fill_in";
	case QuestionType::open_answer:
		return "open_answer";
	case QuestionType::execution_trace:
		return "execution_trace";
	case QuestionType::debugging:
		return "debugging";
	case QuestionType::code_change_prediction:
		return "code_change_prediction";
	case QuestionType::architecture_design:
		return "architecture_design";
	}
	return "open_answer";
}

const char* to_string(EvaluationMode mode) noexcept
{
	switch(mode)
	{
	case EvaluationMode::deterministic:
		return "deterministic";
	case EvaluationMode::model_assisted:
		return "model_assisted";
	}
	return "model_assisted";
}

QuestionType question_type_from_string(const std::string& name)
{
	if(name == "single_choice")
	{
		return QuestionType::single_choice;
	}
	if(name == "multiple_choice")
	{
		return QuestionType::multiple_choice;
	}
	if(name == "true_false")
	{
		return QuestionType::true_false;
	}
	if(name == "fill_in")
	{
		return QuestionType::fill_in;
	}
	if(name == "execution_trace")
	{
		return QuestionType::execution_trace;
	}
	if(name == "debugging")
	{
		return QuestionType::debugging;
	}
	if(name == "code_change_prediction")
	{
		return QuestionType::code_change_prediction;
	}
	if(name == "architecture_design")
	{
		return QuestionType::architecture_design;
	}
	return QuestionType::open_answer;
}

EvaluationMode evaluation_mode_from_string(const std::string& name)
{
	if(name == "deterministic")
	{
		return EvaluationMode::deterministic;
	}
	return EvaluationMode::model_assisted;
}

} // namespace repo_tutor
