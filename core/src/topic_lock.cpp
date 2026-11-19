#include "repo_tutor/topic_lock.hpp"

namespace repo_tutor
{

TopicLockResult check_open_unit(const TutorSession& session, const std::string& unit_id)
{
	const LearningUnit* target = nullptr;
	const LearningUnit* current = nullptr;

	for(const auto& unit: session.units)
	{
		if(unit.id == unit_id)
		{
			target = &unit;
		}
		if(session.current_unit_id.has_value() && unit.id == *session.current_unit_id)
		{
			current = &unit;
		}
	}

	if(target == nullptr)
	{
		return TopicLockResult::blocked_unknown_unit;
	}

	if(current == nullptr)
	{
		return TopicLockResult::allowed;
	}

	if(current->id == target->id)
	{
		return TopicLockResult::allowed;
	}

	if(current->status != LearningUnitStatus::completed)
	{
		return TopicLockResult::blocked_current_unit_unfinished;
	}

	return TopicLockResult::allowed;
}

} // namespace repo_tutor
