#pragma once

#include "repo_tutor/domain.hpp"

// Depth push/pop 是 v0.1 的第二个不变量：
// 下钻只能往更深处走，返回只能弹现有的下钻记录。

namespace repo_tutor
{

enum class DepthPushResult
{
	allowed,
	blocked_not_deeper,
};

enum class DepthPopResult
{
	allowed,
	blocked_empty,
};

// 临时下钻：目标 Depth 必须比当前更深，成功后压栈。
DepthPushResult push_depth(DepthState& state, DepthProfile deeper);

// 返回主线：弹出最近一次下钻；栈空则拒绝。
DepthPopResult pop_depth(DepthState& state);

} // namespace repo_tutor
