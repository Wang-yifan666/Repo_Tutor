#pragma once

// Repo Tutor Core 的版本号。
//
// Batch 1 里，Core 库只对外暴露这一个头文件。它存在的意义很单纯：
// 让 C++20 的构建把「宿主无关的 Core 库」和「可执行文件进程边界」
// 拆成两个独立的东西。领域模型（RepositoryMap、LearningMap、
// TutorState、EvidenceBudget 这些）现在都还没写。

namespace repo_tutor
{

inline constexpr int kVersionMajor = 0;
inline constexpr int kVersionMinor = 1;
inline constexpr int kVersionPatch = 0;

// 单字符串形式，例如 "0.1.0"。
inline constexpr const char* kVersionString = "0.1.0";

// 返回 Core 的版本号字符串（"0.1.0"）。
const char* version_string() noexcept;

} // namespace repo_tutor
