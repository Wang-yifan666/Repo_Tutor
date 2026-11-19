# 宿主无关的 Core 库。M1：值类型 + Topic Lock + Depth + RepositoryMap + Evidence Budget；
# M3 再加 Question 契约。
add_library(repo_tutor_core STATIC
  src/version.cpp
  src/topic_lock.cpp
  src/depth.cpp
  src/repository_map.cpp
  src/evidence_budget.cpp
  src/evidence_reader.cpp
  src/question.cpp
)
add_library(repo_tutor::core ALIAS repo_tutor_core)

target_compile_features(repo_tutor_core PUBLIC cxx_std_20)
target_include_directories(repo_tutor_core PUBLIC
  "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
  "$<INSTALL_INTERFACE:include>"
)
