#include "repo_tutor/depth.hpp"

namespace repo_tutor
{

namespace
{

// 深度比较。枚举顺序就是深度顺序（D1 < D2 < D3 < D4）。
bool is_deeper(DepthProfile candidate, DepthProfile than)
{
	return static_cast<int>(candidate) > static_cast<int>(than);
}

} // namespace

DepthPushResult push_depth(DepthState& state, DepthProfile deeper)
{
	if(!is_deeper(deeper, state.current()))
	{
		return DepthPushResult::blocked_not_deeper;
	}

	state.stack.push_back(deeper);
	return DepthPushResult::allowed;
}

DepthPopResult pop_depth(DepthState& state)
{
	if(state.stack.empty())
	{
		return DepthPopResult::blocked_empty;
	}

	state.stack.pop_back();
	return DepthPopResult::allowed;
}

} // namespace repo_tutor
