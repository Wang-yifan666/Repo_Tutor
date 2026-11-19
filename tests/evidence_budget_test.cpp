#include <cstdio>
#include <cstdlib>

#include "repo_tutor/evidence_budget.hpp"

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
	using repo_tutor::DepthProfile;
	using repo_tutor::EvidenceBudget;
	using repo_tutor::EvidenceEntry;
	using repo_tutor::EvidenceRecordResult;

	// 记录合法相对路径
	{
		EvidenceBudget budget;
		budget.cognitive_goal = "how does the parser work";

		EvidenceEntry entry;
		entry.relative_path = "src/parser.cpp";
		entry.line_start = 10;
		entry.line_end = 40;
		entry.rationale = "parser entry point";

		check(repo_tutor::record_evidence(budget, entry) == EvidenceRecordResult::allowed,
		      "safe relative path should be recorded");
		check(budget.ledger.size() == 1, "ledger should contain one entry");
		check(budget.has_read("src/parser.cpp"), "has_read should see the recorded file");
	}

	// 路径逃逸被拒
	{
		EvidenceBudget budget;
		EvidenceEntry entry;
		entry.relative_path = "../etc/passwd";
		check(repo_tutor::record_evidence(budget, entry) == EvidenceRecordResult::blocked_escape,
		      "escape path should be blocked");
		check(budget.ledger.empty(), "blocked entry should not be recorded");
	}

	// 绝对路径被拒
	{
		EvidenceBudget budget;
		EvidenceEntry entry;
		entry.relative_path = "/etc/passwd";
		check(repo_tutor::record_evidence(budget, entry) == EvidenceRecordResult::blocked_escape,
		      "absolute path should be blocked");
	}

	// 空路径被拒
	{
		EvidenceBudget budget;
		EvidenceEntry entry;
		check(repo_tutor::record_evidence(budget, entry) == EvidenceRecordResult::blocked_escape,
		      "empty path should be blocked");
	}

	// 同一文件读多段，只算一个文件
	{
		EvidenceBudget budget;

		EvidenceEntry first;
		first.relative_path = "src/a.cpp";
		first.line_start = 1;
		first.line_end = 5;

		EvidenceEntry second = first;
		second.line_start = 20;
		second.line_end = 30;

		check(repo_tutor::record_evidence(budget, first) == EvidenceRecordResult::allowed,
		      "first segment allowed");
		check(repo_tutor::record_evidence(budget, second) == EvidenceRecordResult::allowed,
		      "second segment allowed");
		check(budget.ledger.size() == 2, "both segments should be in ledger");
		check(budget.files_read() == 1, "same file read twice should count once");
	}

	// 软护栏随 Depth 单调递增
	{
		const auto d1 = repo_tutor::soft_file_cap(DepthProfile::d1_overview);
		const auto d2 = repo_tutor::soft_file_cap(DepthProfile::d2_working);
		const auto d3 = repo_tutor::soft_file_cap(DepthProfile::d3_implementation);
		const auto d4 = repo_tutor::soft_file_cap(DepthProfile::d4_forensic);

		check(d1 < d2, "d1 cap should be smaller than d2");
		check(d2 < d3, "d2 cap should be smaller than d3");
		check(d3 < d4, "d3 cap should be smaller than d4");
	}

	std::printf("all evidence-budget checks passed\n");
	return 0;
}
