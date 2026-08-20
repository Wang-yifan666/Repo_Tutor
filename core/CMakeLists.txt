# 宿主无关的 Core 库。Batch 1 只放了一个版本号产物，
# 领域模型和 Tutor 引擎后面再加。

add_library(repo_tutor_core STATIC
  src/version.cpp
)
add_library(repo_tutor::core ALIAS repo_tutor_core)

target_compile_features(repo_tutor_core PUBLIC cxx_std_20)
target_include_directories(repo_tutor_core PUBLIC
  "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
  "$<INSTALL_INTERFACE:include>"
)
