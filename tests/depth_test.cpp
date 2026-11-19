#include <cstdio>
#include <cstdlib>

#include "repo_tutor/depth.hpp"

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

} // namespace

int main()
{
	using repo_tutor::DepthPopResult;
	using repo_tutor::DepthProfile;
	using repo_tutor::DepthPushResult;
	using repo_tutor::DepthState;

	// 初始在主线，默认 Depth 生效
	{
		DepthState state;
		check(state.current() == DepthProfile::d2_working, "empty state should use default depth");
	}

	// 单层下钻，然后返回
	{
		DepthState state;
		check(repo_tutor::push_depth(state, DepthProfile::d3_implementation)
		          == DepthPushResult::allowed,
		      "pushing a deeper depth should be allowed");
		check(state.current() == DepthProfile::d3_implementation,
		      "current depth should be the pushed one");
		check(repo_tutor::pop_depth(state) == DepthPopResult::allowed,
		      "popping a pushed depth should be allowed");
		check(state.current() == DepthProfile::d2_working,
		      "after pop, depth should return to default");
	}

	// 不能往更浅处下钻
	{
		DepthState state;
		check(repo_tutor::push_depth(state, DepthProfile::d1_overview)
		          == DepthPushResult::blocked_not_deeper,
		      "shallower depth should be blocked");
		check(state.current() == DepthProfile::d2_working, "blocked push should not change depth");
	}

	// 不能往当前位置同级下钻
	{
		DepthState state;
		check(repo_tutor::push_depth(state, DepthProfile::d2_working)
		          == DepthPushResult::blocked_not_deeper,
		      "same depth should be blocked");
	}

	// 多级下钻，逐层返回
	{
		DepthState state;
		check(repo_tutor::push_depth(state, DepthProfile::d3_implementation)
		          == DepthPushResult::allowed,
		      "push d3 should be allowed");
		check(repo_tutor::push_depth(state, DepthProfile::d4_forensic) == DepthPushResult::allowed,
		      "push d4 from d3 should be allowed");
		check(state.current() == DepthProfile::d4_forensic, "current depth should be d4");
		check(repo_tutor::pop_depth(state) == DepthPopResult::allowed, "pop d4 should be allowed");
		check(state.current() == DepthProfile::d3_implementation,
		      "current depth should fall back to d3");
		check(repo_tutor::pop_depth(state) == DepthPopResult::allowed, "pop d3 should be allowed");
		check(state.current() == DepthProfile::d2_working,
		      "current depth should be back to default");
	}

	// 没有下钻时不能返回
	{
		DepthState state;
		check(repo_tutor::pop_depth(state) == DepthPopResult::blocked_empty,
		      "popping empty stack should be blocked");
	}

	std::printf("all depth checks passed\n");
	return 0;
}
