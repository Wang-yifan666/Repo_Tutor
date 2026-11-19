# 最小的 CTest 接线：每个测试文件一个 executable（各自有 main），
# 再加一个跑可执行文件的 smoke 测试。不引入第三方测试框架。

add_executable(repo_tutor_version_test
  version_test.cpp
)
target_link_libraries(repo_tutor_version_test PRIVATE repo_tutor::core)

add_executable(repo_tutor_topic_lock_test
  topic_lock_test.cpp
)
target_link_libraries(repo_tutor_topic_lock_test PRIVATE repo_tutor::core)

add_executable(repo_tutor_depth_test
  depth_test.cpp
)
target_link_libraries(repo_tutor_depth_test PRIVATE repo_tutor::core)

add_executable(repo_tutor_repository_map_test
  repository_map_test.cpp
)
target_link_libraries(repo_tutor_repository_map_test PRIVATE repo_tutor::core)

add_executable(repo_tutor_evidence_budget_test
  evidence_budget_test.cpp
)
target_link_libraries(repo_tutor_evidence_budget_test PRIVATE repo_tutor::core)

add_executable(repo_tutor_evidence_reader_test
  evidence_reader_test.cpp
)
target_link_libraries(repo_tutor_evidence_reader_test PRIVATE repo_tutor::core)

# 黑盒测试：只通过 stdio 驱动可执行文件，不链接 Core 内部。
add_executable(repo_tutor_protocol_blackbox_test
  protocol_blackbox_test.cpp
)

# 垂直切片：test client 驱动完整教学闭环
# session → map → unit → evidence → 问题 → 评价 → 状态更新。
add_executable(repo_tutor_vertical_slice_test
  vertical_slice_test.cpp
)

add_test(NAME core.version.test COMMAND repo_tutor_version_test)
add_test(NAME core.topic_lock.test COMMAND repo_tutor_topic_lock_test)
add_test(NAME core.depth.test COMMAND repo_tutor_depth_test)
add_test(NAME core.repository_map.test COMMAND repo_tutor_repository_map_test)
add_test(NAME core.evidence_budget.test COMMAND repo_tutor_evidence_budget_test)
add_test(NAME core.evidence_reader.test COMMAND repo_tutor_evidence_reader_test)
add_test(NAME protocol.blackbox COMMAND repo_tutor_protocol_blackbox_test $<TARGET_FILE:repo_tutor_core_cli>)
add_test(NAME vertical.slice COMMAND repo_tutor_vertical_slice_test $<TARGET_FILE:repo_tutor_core_cli>)
add_test(NAME cli.smoke COMMAND repo_tutor_core_cli)
