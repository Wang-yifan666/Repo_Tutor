# 最小的 CTest 接线：一个针对 Core 库的单元测试，加一个跑可执行文件的
# smoke 测试。不引入第三方测试框架。

add_executable(repo_tutor_core_test
  version_test.cpp
)
target_link_libraries(repo_tutor_core_test PRIVATE repo_tutor::core)

add_test(NAME core.version.test COMMAND repo_tutor_core_test)
add_test(NAME cli.smoke COMMAND repo_tutor_core_cli)
