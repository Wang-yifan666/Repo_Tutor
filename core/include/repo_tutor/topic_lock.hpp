#pragma once

#include <string>

#include "repo_tutor/domain.hpp"

// Topic Lock 是 v0.1 的第一个真正不变量：当前学习单元的认知目标还没完成时，
// 不允许打开另一个单元。它绑定的是单元的完成状态，跟"有没有答题"无关。

namespace repo_tutor
{

enum class TopicLockResult
{
	allowed,
	blocked_unknown_unit,
	blocked_current_unit_unfinished,
};

// 判断能不能打开 unit_id。
//
// 放行的情况：
//   - 目标单元就是当前单元（继续 / 重入）
//   - 还没有当前单元
//   - 当前单元已经 completed
// 其余都拦下：目标单元不存在，或当前单元还没完成却想切走。
TopicLockResult check_open_unit(const TutorSession& session, const std::string& unit_id);

} // namespace repo_tutor
