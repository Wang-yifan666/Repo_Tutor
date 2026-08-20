cmake_minimum_required(VERSION 3.20)

project(repo_tutor
  VERSION 0.1.0
  DESCRIPTION "Interactive repository tutor"
  LANGUAGES CXX
)

# Batch 1 脚手架：定下 C++20 基线，顺便把「宿主无关的 Core 库」和
# 「可执行文件进程边界」拆成两个独立 target。
#
# 现在不引入任何第三方依赖。Tutor 领域引擎、宿主无关的 Tutor 协议、
# 宿主 adapter，这些都留到后面的批次。

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(REPO_TUTOR_BUILD_TESTS "构建 Repo Tutor 测试" ON)

add_subdirectory(core)
add_subdirectory(apps/repo-tutor-core)

if(REPO_TUTOR_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()
