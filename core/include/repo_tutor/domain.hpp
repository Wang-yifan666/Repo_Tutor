#pragma once

#include <optional>
#include <string>
#include <vector>

// M1 先放最基础的值类型：Depth、Coverage 两个 profile，学习单元，
// 以及不变量需要的 TutorSession 最小状态。EvidenceBudget、LearningMap、
// EvidenceSnapshot 这些后面再加。

namespace repo_tutor
{

// Depth 不是永久全局设定。会话有默认值，某个 topic 可以临时下钻，再回来。
// 枚举顺序就是深度顺序：D1 < D2 < D3 < D4。
enum class DepthProfile
{
	d1_overview,
	d2_working,
	d3_implementation,
	d4_forensic,
};

// Coverage 决定这次教到哪一层。
enum class CoverageProfile
{
	core_path,
	major_modules,
	comprehensive,
};

enum class LearningUnitStatus
{
	not_started,
	in_progress,
	completed,
};

// 一个学习单元只服务一个认知目标，可以横跨多个直接相关的文件。
struct LearningUnit
{
	std::string id;
	std::string cognitive_goal;
	LearningUnitStatus status = LearningUnitStatus::not_started;
};

// Depth 的运行时状态：默认 Depth + 临时下钻栈。
// 栈空表示在主线，栈顶表示当前下钻到的 Depth。
struct DepthState
{
	DepthProfile default_depth = DepthProfile::d2_working;
	// 下钻记录，只存比默认/上一层更深的 Depth。
	std::vector<DepthProfile> stack;

	// 当前生效的 Depth：有下钻就取栈顶，否则取默认值。
	DepthProfile current() const
	{
		return stack.empty() ? default_depth : stack.back();
	}
};

// TutorSession 的 M1 最小状态。等状态机再长起来，继续往这里加。
// revision 每次状态变化 +1；QuestionContract 记下提问时的 revision。
struct TutorSession
{
	std::string id;
	CoverageProfile coverage = CoverageProfile::core_path;
	DepthState depth;
	std::vector<LearningUnit> units;
	std::optional<std::string> current_unit_id;
	int revision = 0;
};

} // namespace repo_tutor
