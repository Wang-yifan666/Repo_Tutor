#include <cstdio>
#include <cstdlib>

#include "repo_tutor/topic_lock.hpp"

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

repo_tutor::LearningUnit make_unit(const char* id, repo_tutor::LearningUnitStatus status)
{
	repo_tutor::LearningUnit unit;
	unit.id = id;
	unit.cognitive_goal = id;
	unit.status = status;
	return unit;
}

} // namespace

int main()
{
	using repo_tutor::LearningUnitStatus;
	using repo_tutor::TopicLockResult;

	// 还没有当前单元：可以打开任何存在的单元
	{
		repo_tutor::TutorSession session;
		session.units.push_back(make_unit("unit-a", LearningUnitStatus::not_started));
		check(repo_tutor::check_open_unit(session, "unit-a") == TopicLockResult::allowed,
		      "empty session should allow opening a known unit");
	}

	// 打开不存在的单元：拦下
	{
		repo_tutor::TutorSession session;
		session.current_unit_id = "unit-a";
		session.units.push_back(make_unit("unit-a", LearningUnitStatus::in_progress));
		check(repo_tutor::check_open_unit(session, "unit-missing")
		          == TopicLockResult::blocked_unknown_unit,
		      "unknown unit should be blocked");
	}

	// 当前单元进行中，切到另一个单元：拦下
	{
		repo_tutor::TutorSession session;
		session.current_unit_id = "unit-a";
		session.units.push_back(make_unit("unit-a", LearningUnitStatus::in_progress));
		session.units.push_back(make_unit("unit-b", LearningUnitStatus::not_started));
		check(repo_tutor::check_open_unit(session, "unit-b")
		          == TopicLockResult::blocked_current_unit_unfinished,
		      "unfinished current unit should block switching");
	}

	// 当前单元已完成，可以切换
	{
		repo_tutor::TutorSession session;
		session.current_unit_id = "unit-a";
		session.units.push_back(make_unit("unit-a", LearningUnitStatus::completed));
		session.units.push_back(make_unit("unit-b", LearningUnitStatus::not_started));
		check(repo_tutor::check_open_unit(session, "unit-b") == TopicLockResult::allowed,
		      "completed current unit should allow switching");
	}

	// 重入当前单元：放行
	{
		repo_tutor::TutorSession session;
		session.current_unit_id = "unit-a";
		session.units.push_back(make_unit("unit-a", LearningUnitStatus::in_progress));
		check(repo_tutor::check_open_unit(session, "unit-a") == TopicLockResult::allowed,
		      "reopening the current unit should be allowed");
	}

	std::printf("all topic-lock checks passed\n");
	return 0;
}
